begin;

-- Complete finance layer for the Receiving Point. Hangar logic is intentionally untouched.
create table if not exists public.receiving_receipt_payments(
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  receipt_id uuid not null references public.receiving_receipts(id) on delete cascade,
  method text not null check(method in ('CASH','KASPI','TRANSFER','DEBT')),
  amount numeric(18,2) not null check(amount>0),
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists receiving_receipt_payments_receipt_idx on public.receiving_receipt_payments(workspace_id,receipt_id);

create table if not exists public.receiving_sale_payments(
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  sale_id uuid not null references public.receiving_sales(id) on delete cascade,
  method text not null check(method in ('CASH','KASPI','TRANSFER','DEBT')),
  amount numeric(18,2) not null check(amount>0),
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists receiving_sale_payments_sale_idx on public.receiving_sale_payments(workspace_id,sale_id);

create table if not exists public.receiving_contractor_ledger(
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contractor_id uuid references public.contractors(id) on delete set null,
  party_name text,
  ledger_side text not null check(ledger_side in ('WE_OWE','THEY_OWE')),
  entry_type text not null check(entry_type in ('RECEIPT_DEBT','RECEIPT_DEBT_REPAY','SALE_DEBT','SALE_DEBT_REPAY')),
  amount numeric(18,2) not null check(amount>0),
  receipt_id uuid references public.receiving_receipts(id) on delete set null,
  sale_id uuid references public.receiving_sales(id) on delete set null,
  tx_date date not null,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists receiving_contractor_ledger_idx on public.receiving_contractor_ledger(workspace_id,contractor_id,tx_date desc,created_at desc);

alter table public.employee_transactions add column if not exists cash_transaction_id bigint references public.receiving_cash_transactions(id) on delete set null;

alter table public.receiving_receipt_payments enable row level security;
alter table public.receiving_sale_payments enable row level security;
alter table public.receiving_contractor_ledger enable row level security;
create policy receiving_receipt_payments_all on public.receiving_receipt_payments for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy receiving_sale_payments_all on public.receiving_sale_payments for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy receiving_contractor_ledger_all on public.receiving_contractor_ledger for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());

create or replace function public.next_receiving_number(p_date date) returns bigint language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_n bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_ws::text||':receipt:'||p_date::text,31));
  select coalesce(max(receipt_number),0)+1 into v_n from public.receiving_receipts where workspace_id=v_ws and receipt_date=p_date;
  return v_n;
end; $$;

create or replace function public.next_receiving_sale_number(p_date date) returns bigint language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_n bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_ws::text||':sale:'||p_date::text,31));
  select coalesce(max(sale_number),0)+1 into v_n from public.receiving_sales where workspace_id=v_ws and sale_date=p_date;
  return v_n;
end; $$;

create or replace function public.next_receiving_transfer_number(p_date date) returns bigint language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_n bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_ws::text||':transfer:'||p_date::text,31));
  select coalesce(max(transfer_number),0)+1 into v_n from public.receiving_transfers where workspace_id=v_ws and transfer_date=p_date;
  return v_n;
end; $$;

create or replace function public.create_receiving_receipt_v2(
  p_date date,
  p_source_type text,
  p_contractor_id uuid,
  p_source_name text,
  p_receiver_name text,
  p_items jsonb,
  p_payments jsonb default '[]'::jsonb,
  p_note text default null
) returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_ws uuid:=public.current_workspace_id(); v_id uuid; v_num bigint; r jsonb; pay jsonb;
  v_total numeric:=0; v_paid numeric:=0; v_debt numeric:=0; v_amount numeric;
  v_method text;
begin
  if v_ws is null then raise exception 'Нет доступа к складу'; end if;
  if coalesce(jsonb_array_length(p_items),0)=0 then raise exception 'Нет товаров в приёмке'; end if;
  v_num:=public.next_receiving_number(p_date);
  insert into public.receiving_receipts(workspace_id,receipt_number,receipt_date,source_type,contractor_id,source_name,receiver_name,note,created_by)
  values(v_ws,v_num,p_date,coalesce(nullif(p_source_type,''),'PHYSICAL_PERSON'),p_contractor_id,nullif(trim(p_source_name),''),nullif(trim(p_receiver_name),''),p_note,auth.uid())
  returning id into v_id;

  for r in select * from jsonb_array_elements(p_items) loop
    if (r->>'kg')::numeric <= 0 then continue; end if;
    insert into public.receiving_receipt_items(workspace_id,receipt_id,product_id,quantity_kg,unit_cost,waste_kg)
    values(v_ws,v_id,(r->>'product_id')::uuid,(r->>'kg')::numeric,(r->>'price')::numeric,coalesce((r->>'wasteKg')::numeric,0));
    v_total:=v_total+round((r->>'kg')::numeric*(r->>'price')::numeric,2);
    perform pg_advisory_xact_lock(hashtextextended(v_ws::text||(r->>'product_id'),31));
    insert into public.receiving_stock_balances(workspace_id,product_id,quantity_kg,cost_amount,updated_at)
    values(v_ws,(r->>'product_id')::uuid,(r->>'kg')::numeric,round((r->>'kg')::numeric*(r->>'price')::numeric,2),now())
    on conflict(workspace_id,product_id) do update set quantity_kg=receiving_stock_balances.quantity_kg+excluded.quantity_kg,cost_amount=receiving_stock_balances.cost_amount+excluded.cost_amount,updated_at=now();
  end loop;
  update public.receiving_receipts set total_amount=v_total where id=v_id;

  for pay in select * from jsonb_array_elements(coalesce(p_payments,'[]'::jsonb)) loop
    v_method:=upper(trim(pay->>'method')); v_amount:=round((pay->>'amount')::numeric,2);
    if v_amount<=0 then continue; end if;
    if v_method not in ('CASH','KASPI','TRANSFER','DEBT') then raise exception 'Неверный способ расчёта: %',v_method; end if;
    insert into public.receiving_receipt_payments(workspace_id,receipt_id,method,amount,note,created_by)
    values(v_ws,v_id,v_method,v_amount,pay->>'note',auth.uid());
    if v_method='DEBT' then
      v_debt:=v_debt+v_amount;
      insert into public.receiving_contractor_ledger(workspace_id,contractor_id,party_name,ledger_side,entry_type,amount,receipt_id,tx_date,note,created_by)
      values(v_ws,p_contractor_id,nullif(trim(p_source_name),''),'WE_OWE','RECEIPT_DEBT',v_amount,v_id,p_date,p_note,auth.uid());
    else
      v_paid:=v_paid+v_amount;
      insert into public.receiving_cash_transactions(workspace_id,tx_date,direction,method,category,amount,receipt_id,contractor_id,note,created_by)
      values(v_ws,p_date,'IN',v_method,'RECEIPT_PAYMENT',v_amount,v_id,p_contractor_id,pay->>'note',auth.uid());
    end if;
  end loop;
  if round(v_paid+v_debt,2) <> round(v_total,2) then raise exception 'Расчёт не сходится: приёмка %, оплачено %, долг %',v_total,v_paid,v_debt; end if;
  return v_id;
end; $$;

create or replace function public.create_receiving_sale_v2(
  p_date date,
  p_contractor_id uuid,
  p_buyer_name text,
  p_items jsonb,
  p_payments jsonb default '[]'::jsonb,
  p_note text default null
) returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_ws uuid:=public.current_workspace_id(); v_id uuid; v_num bigint; r jsonb; pay jsonb;
  v_total numeric:=0; v_cogs numeric:=0; v_avg numeric; v_paid numeric:=0; v_debt numeric:=0; v_amount numeric; v_method text;
begin
  if v_ws is null then raise exception 'Нет доступа к складу'; end if;
  if coalesce(jsonb_array_length(p_items),0)=0 then raise exception 'Нет товаров в отгрузке'; end if;
  v_num:=public.next_receiving_sale_number(p_date);
  insert into public.receiving_sales(workspace_id,sale_number,sale_date,contractor_id,buyer_name,note,created_by)
  values(v_ws,v_num,p_date,p_contractor_id,nullif(trim(p_buyer_name),''),p_note,auth.uid()) returning id into v_id;
  for r in select * from jsonb_array_elements(p_items) loop
    perform pg_advisory_xact_lock(hashtextextended(v_ws::text||(r->>'product_id'),31));
    select case when quantity_kg>0 then round(cost_amount/quantity_kg,2) else 0 end into v_avg from public.receiving_stock_balances where workspace_id=v_ws and product_id=(r->>'product_id')::uuid for update;
    if not exists(select 1 from public.receiving_stock_balances where workspace_id=v_ws and product_id=(r->>'product_id')::uuid and quantity_kg+0.000001 >= (r->>'kg')::numeric) then raise exception 'Недостаточный остаток на Пункте приёмки'; end if;
    insert into public.receiving_sale_items(workspace_id,sale_id,product_id,quantity_kg,unit_price,cogs_amount)
    values(v_ws,v_id,(r->>'product_id')::uuid,(r->>'kg')::numeric,(r->>'price')::numeric,round((r->>'kg')::numeric*coalesce(v_avg,0),2));
    update public.receiving_stock_balances set quantity_kg=quantity_kg-(r->>'kg')::numeric,cost_amount=greatest(0,cost_amount-round((r->>'kg')::numeric*coalesce(v_avg,0),2)),updated_at=now() where workspace_id=v_ws and product_id=(r->>'product_id')::uuid;
    v_total:=v_total+round((r->>'kg')::numeric*(r->>'price')::numeric,2); v_cogs:=v_cogs+round((r->>'kg')::numeric*coalesce(v_avg,0),2);
  end loop;
  update public.receiving_sales set total_amount=v_total,cogs_amount=v_cogs where id=v_id;
  for pay in select * from jsonb_array_elements(coalesce(p_payments,'[]'::jsonb)) loop
    v_method:=upper(trim(pay->>'method')); v_amount:=round((pay->>'amount')::numeric,2);
    if v_amount<=0 then continue; end if;
    if v_method not in ('CASH','KASPI','TRANSFER','DEBT') then raise exception 'Неверный способ расчёта: %',v_method; end if;
    insert into public.receiving_sale_payments(workspace_id,sale_id,method,amount,note,created_by)
    values(v_ws,v_id,v_method,v_amount,pay->>'note',auth.uid());
    if v_method='DEBT' then
      v_debt:=v_debt+v_amount;
      insert into public.receiving_contractor_ledger(workspace_id,contractor_id,party_name,ledger_side,entry_type,amount,sale_id,tx_date,note,created_by)
      values(v_ws,p_contractor_id,nullif(trim(p_buyer_name),''),'THEY_OWE','SALE_DEBT',v_amount,v_id,p_date,p_note,auth.uid());
    else
      v_paid:=v_paid+v_amount;
      insert into public.receiving_cash_transactions(workspace_id,tx_date,direction,method,category,amount,sale_id,contractor_id,note,created_by)
      values(v_ws,p_date,'IN',v_method,'SALE_PAYMENT',v_amount,v_id,p_contractor_id,pay->>'note',auth.uid());
    end if;
  end loop;
  if round(v_paid+v_debt,2) <> round(v_total,2) then raise exception 'Расчёт не сходится: отгрузка %, оплачено %, долг %',v_total,v_paid,v_debt; end if;
  return v_id;
end; $$;

create or replace function public.create_receiving_employee_finance(
  p_employee_id uuid,p_date date,p_tx_type text,p_amount numeric,p_method text default 'CASH',p_note text default null
) returns bigint language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_id bigint; v_dir text; v_cat text;
begin
  if p_amount<=0 then raise exception 'Сумма должна быть больше нуля'; end if;
  if p_tx_type not in ('ADVANCE','SALARY','DEBT','DEBT_REPAY','PROCESSING_PAY','OTHER') then raise exception 'Неверный тип операции'; end if;
  if p_method not in ('CASH','KASPI','TRANSFER') then raise exception 'Неверный способ выплаты'; end if;
  insert into public.employee_transactions(workspace_id,employee_id,tx_date,tx_type,amount,method,note,created_by)
  values(v_ws,p_employee_id,p_date,p_tx_type,p_amount,p_method,p_note,auth.uid()) returning id into v_id;
  v_dir:=case when p_tx_type='DEBT_REPAY' then 'IN' else 'OUT' end;
  v_cat:=case p_tx_type when 'ADVANCE' then 'EMPLOYEE_ADVANCE' when 'SALARY' then 'SALARY' when 'DEBT' then 'EMPLOYEE_DEBT' when 'DEBT_REPAY' then 'EMPLOYEE_DEBT_REPAY' when 'PROCESSING_PAY' then 'PROCESSING_PAY' else 'EMPLOYEE_OTHER' end;
  insert into public.receiving_cash_transactions(workspace_id,tx_date,direction,method,category,amount,employee_id,note,created_by)
  values(v_ws,p_date,v_dir,p_method,v_cat,p_amount,p_employee_id,p_note,auth.uid()) returning id into v_id;
  return v_id;
end; $$;

create or replace function public.close_receiving_day_v2(
  p_date date,p_actual_cash numeric,p_actual_kaspi numeric,p_actual_transfer numeric,p_reason text default null
) returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_id uuid; ec numeric; ek numeric; et numeric; variance numeric;
begin
  if v_ws is null then raise exception 'Нет доступа к складу'; end if;
  select coalesce(sum(case when direction='IN' and method='CASH' then amount else -amount end),0),
         coalesce(sum(case when direction='IN' and method='KASPI' then amount else -amount end),0),
         coalesce(sum(case when direction='IN' and method='TRANSFER' then amount else -amount end),0)
  into ec,ek,et from public.receiving_cash_transactions where workspace_id=v_ws and tx_date=p_date;
  variance:=round((p_actual_cash-ec)+(p_actual_kaspi-ek)+(p_actual_transfer-et),2);
  if variance<>0 and coalesce(nullif(trim(p_reason),''),'')='' then raise exception 'Есть расхождение % ₸. Укажите причину.',variance; end if;
  insert into public.receiving_day_closings(workspace_id,close_date,expected_total,actual_cash,actual_kaspi,actual_transfer,variance,reason,status,closed_by,closed_at)
  values(v_ws,p_date,round(ec+ek+et,2),p_actual_cash,p_actual_kaspi,p_actual_transfer,variance,nullif(trim(p_reason),''),'CLOSED',auth.uid(),now())
  on conflict(workspace_id,close_date) do update set expected_total=excluded.expected_total,actual_cash=excluded.actual_cash,actual_kaspi=excluded.actual_kaspi,actual_transfer=excluded.actual_transfer,variance=excluded.variance,reason=excluded.reason,status='CLOSED',closed_by=auth.uid(),closed_at=now()
  returning id into v_id;
  return v_id;
end; $$;


create or replace function public.create_receiving_contractor_debt_repayment(
  p_contractor_id uuid,p_date date,p_amount numeric,p_side text,p_method text,p_note text default null
) returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_balance numeric; v_cash_dir text; v_entry text; v_method text;
begin
  if p_amount<=0 then raise exception 'Сумма должна быть больше нуля'; end if;
  if p_side not in ('WE_OWE','THEY_OWE') then raise exception 'Неверная сторона долга'; end if;
  if p_method not in ('CASH','KASPI','TRANSFER') then raise exception 'Неверный способ оплаты'; end if;
  select case when p_side='WE_OWE' then
      coalesce(sum(case when entry_type='RECEIPT_DEBT' then amount when entry_type='RECEIPT_DEBT_REPAY' then -amount else 0 end),0)
    else
      coalesce(sum(case when entry_type='SALE_DEBT' then amount when entry_type='SALE_DEBT_REPAY' then -amount else 0 end),0)
    end into v_balance
  from public.receiving_contractor_ledger where workspace_id=v_ws and contractor_id=p_contractor_id and ledger_side=p_side;
  if p_amount>v_balance+0.01 then raise exception 'Сумма погашения больше долга. Остаток: %',v_balance; end if;
  v_cash_dir:=case when p_side='WE_OWE' then 'OUT' else 'IN' end;
  v_entry:=case when p_side='WE_OWE' then 'RECEIPT_DEBT_REPAY' else 'SALE_DEBT_REPAY' end;
  insert into public.receiving_contractor_ledger(workspace_id,contractor_id,ledger_side,entry_type,amount,tx_date,note,created_by)
  values(v_ws,p_contractor_id,p_side,v_entry,p_amount,p_date,p_note,auth.uid());
  insert into public.receiving_cash_transactions(workspace_id,tx_date,direction,method,category,amount,contractor_id,note,created_by)
  values(v_ws,p_date,v_cash_dir,p_method,'CONTRACTOR_DEBT_REPAY',p_amount,p_contractor_id,p_note,auth.uid());
end; $$;

-- Helpful read models for the new UI.
create or replace view public.receiving_contractor_balances as
select workspace_id, contractor_id,
       sum(case when ledger_side='WE_OWE' and entry_type in ('RECEIPT_DEBT') then amount else 0 end)
       -sum(case when ledger_side='WE_OWE' and entry_type in ('RECEIPT_DEBT_REPAY') then amount else 0 end) as we_owe,
       sum(case when ledger_side='THEY_OWE' and entry_type in ('SALE_DEBT') then amount else 0 end)
       -sum(case when ledger_side='THEY_OWE' and entry_type in ('SALE_DEBT_REPAY') then amount else 0 end) as they_owe
from public.receiving_contractor_ledger group by workspace_id,contractor_id;

grant select on public.receiving_contractor_balances to authenticated;

commit;
