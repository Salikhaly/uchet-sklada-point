begin;

-- New role used only for internal transfer from the receiving point into the hangar.
create table if not exists public.receiving_receipts(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  receipt_number bigint not null,
  receipt_date date not null,
  source_type text not null default 'PHYSICAL_PERSON',
  contractor_id uuid references public.contractors(id) on delete set null,
  source_name text,
  receiver_name text,
  note text,
  total_amount numeric(18,2) not null default 0,
  status text not null default 'CONFIRMED' check(status in ('CONFIRMED','CANCELLED')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index if not exists receiving_receipts_num_uq on public.receiving_receipts(workspace_id,receipt_date,receipt_number);
create index if not exists receiving_receipts_date_idx on public.receiving_receipts(workspace_id,receipt_date desc,created_at desc);

create table if not exists public.receiving_receipt_items(
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  receipt_id uuid not null references public.receiving_receipts(id) on delete cascade,
  product_id uuid not null references public.products(id),
  quantity_kg numeric(16,3) not null check(quantity_kg>0),
  unit_cost numeric(14,2) not null check(unit_cost>=0),
  total_amount numeric(18,2) generated always as(round(quantity_kg*unit_cost,2)) stored,
  waste_kg numeric(16,3) not null default 0 check(waste_kg>=0 and waste_kg<=quantity_kg)
);
create index if not exists receiving_receipt_items_product_idx on public.receiving_receipt_items(workspace_id,product_id);

create table if not exists public.receiving_stock_balances(
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity_kg numeric(16,3) not null default 0 check(quantity_kg>=0),
  cost_amount numeric(18,2) not null default 0 check(cost_amount>=0),
  avg_cost numeric(14,2) generated always as(case when quantity_kg>0 then round(cost_amount/quantity_kg,2) else 0 end) stored,
  loading_status text not null default 'HOLD' check(loading_status in ('READY','HOLD','CHECK')),
  updated_at timestamptz not null default now(),
  primary key(workspace_id,product_id)
);

create table if not exists public.receiving_sales(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  sale_number bigint not null,
  sale_date date not null,
  contractor_id uuid references public.contractors(id) on delete set null,
  buyer_name text,
  note text,
  total_amount numeric(18,2) not null default 0,
  cogs_amount numeric(18,2) not null default 0,
  status text not null default 'CONFIRMED' check(status in ('CONFIRMED','CANCELLED')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index if not exists receiving_sales_num_uq on public.receiving_sales(workspace_id,sale_date,sale_number);

create table if not exists public.receiving_sale_items(
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  sale_id uuid not null references public.receiving_sales(id) on delete cascade,
  product_id uuid not null references public.products(id),
  quantity_kg numeric(16,3) not null check(quantity_kg>0),
  unit_price numeric(14,2) not null check(unit_price>=0),
  cogs_amount numeric(18,2) not null default 0,
  total_amount numeric(18,2) generated always as(round(quantity_kg*unit_price,2)) stored
);
create index if not exists receiving_sale_items_product_idx on public.receiving_sale_items(workspace_id,product_id);

create table if not exists public.receiving_transfers(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  transfer_number bigint not null,
  transfer_date date not null,
  note text,
  total_cost numeric(18,2) not null default 0,
  status text not null default 'CONFIRMED' check(status in ('CONFIRMED','CANCELLED')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index if not exists receiving_transfers_num_uq on public.receiving_transfers(workspace_id,transfer_date,transfer_number);

create table if not exists public.receiving_transfer_items(
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  transfer_id uuid not null references public.receiving_transfers(id) on delete cascade,
  product_id uuid not null references public.products(id),
  quantity_kg numeric(16,3) not null check(quantity_kg>0),
  unit_cost numeric(14,2) not null check(unit_cost>=0),
  total_amount numeric(18,2) generated always as(round(quantity_kg*unit_cost,2)) stored,
  hangar_operation_id uuid references public.operations(id) on delete set null
);
create index if not exists receiving_transfer_items_product_idx on public.receiving_transfer_items(workspace_id,product_id);

create table if not exists public.employees(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists employees_workspace_name_uq on public.employees(workspace_id,lower(name));

create table if not exists public.employee_transactions(
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  tx_date date not null,
  tx_type text not null check(tx_type in ('ADVANCE','SALARY','DEBT','DEBT_REPAY','PROCESSING_PAY','OTHER')),
  amount numeric(18,2) not null check(amount>=0),
  method text not null default 'CASH',
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.receiving_cash_transactions(
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  tx_date date not null,
  direction text not null check(direction in ('IN','OUT')),
  method text not null check(method in ('CASH','KASPI','TRANSFER')),
  category text not null,
  amount numeric(18,2) not null check(amount>0),
  receipt_id uuid references public.receiving_receipts(id) on delete set null,
  sale_id uuid references public.receiving_sales(id) on delete set null,
  contractor_id uuid references public.contractors(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists receiving_cash_date_idx on public.receiving_cash_transactions(workspace_id,tx_date desc,created_at desc);

create table if not exists public.receiving_day_closings(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  close_date date not null,
  expected_total numeric(18,2) not null default 0,
  actual_cash numeric(18,2) not null default 0,
  actual_kaspi numeric(18,2) not null default 0,
  actual_transfer numeric(18,2) not null default 0,
  variance numeric(18,2) not null default 0,
  reason text,
  status text not null default 'OPEN' check(status in ('OPEN','CLOSED')),
  closed_by uuid references auth.users(id),
  closed_at timestamptz
);
create unique index if not exists receiving_day_closing_date_uq on public.receiving_day_closings(workspace_id,close_date);

-- RLS
alter table public.receiving_receipts enable row level security;
alter table public.receiving_receipt_items enable row level security;
alter table public.receiving_stock_balances enable row level security;
alter table public.receiving_sales enable row level security;
alter table public.receiving_sale_items enable row level security;
alter table public.receiving_transfers enable row level security;
alter table public.receiving_transfer_items enable row level security;
alter table public.employees enable row level security;
alter table public.employee_transactions enable row level security;
alter table public.receiving_cash_transactions enable row level security;
alter table public.receiving_day_closings enable row level security;

create policy receiving_receipts_all on public.receiving_receipts for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy receiving_receipt_items_all on public.receiving_receipt_items for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy receiving_stock_all on public.receiving_stock_balances for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy receiving_sales_all on public.receiving_sales for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy receiving_sale_items_all on public.receiving_sale_items for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy receiving_transfers_all on public.receiving_transfers for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy receiving_transfer_items_all on public.receiving_transfer_items for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy employees_all on public.employees for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy employee_transactions_all on public.employee_transactions for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy receiving_cash_all on public.receiving_cash_transactions for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy receiving_day_closings_all on public.receiving_day_closings for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());

create or replace function public.next_receiving_number(p_date date) returns bigint language sql security definer set search_path=public,pg_catalog as $$
  select coalesce(max(receipt_number),0)+1 from public.receiving_receipts where workspace_id=public.current_workspace_id() and receipt_date=p_date;
$$;
create or replace function public.next_receiving_sale_number(p_date date) returns bigint language sql security definer set search_path=public,pg_catalog as $$
  select coalesce(max(sale_number),0)+1 from public.receiving_sales where workspace_id=public.current_workspace_id() and sale_date=p_date;
$$;
create or replace function public.next_receiving_transfer_number(p_date date) returns bigint language sql security definer set search_path=public,pg_catalog as $$
  select coalesce(max(transfer_number),0)+1 from public.receiving_transfers where workspace_id=public.current_workspace_id() and transfer_date=p_date;
$$;

create or replace function public.create_receiving_receipt(p_date date,p_source_type text,p_contractor_id uuid,p_source_name text,p_receiver_name text,p_items jsonb,p_note text default null,p_cash_method text default null,p_cash_amount numeric default 0)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_id uuid; v_num bigint; r jsonb; v_total numeric:=0; v_cash numeric:=coalesce(p_cash_amount,0);
begin
  if v_ws is null then raise exception 'Нет доступа к складу'; end if;
  v_num:=public.next_receiving_number(p_date);
  insert into public.receiving_receipts(workspace_id,receipt_number,receipt_date,source_type,contractor_id,source_name,receiver_name,note,created_by)
  values(v_ws,v_num,p_date,coalesce(nullif(p_source_type,''),'PHYSICAL_PERSON'),p_contractor_id,nullif(trim(p_source_name),''),nullif(trim(p_receiver_name),''),p_note,auth.uid()) returning id into v_id;
  for r in select * from jsonb_array_elements(p_items) loop
    insert into public.receiving_receipt_items(workspace_id,receipt_id,product_id,quantity_kg,unit_cost,waste_kg)
    values(v_ws,v_id,(r->>'product_id')::uuid,(r->>'kg')::numeric,(r->>'price')::numeric,coalesce((r->>'wasteKg')::numeric,0));
    v_total:=v_total+round((r->>'kg')::numeric*(r->>'price')::numeric,2);
    perform pg_advisory_xact_lock(hashtextextended(v_ws::text||(r->>'product_id'),31));
    insert into public.receiving_stock_balances(workspace_id,product_id,quantity_kg,cost_amount,updated_at)
    values(v_ws,(r->>'product_id')::uuid,(r->>'kg')::numeric,round((r->>'kg')::numeric*(r->>'price')::numeric,2),now())
    on conflict(workspace_id,product_id) do update set quantity_kg=receiving_stock_balances.quantity_kg+excluded.quantity_kg,cost_amount=receiving_stock_balances.cost_amount+excluded.cost_amount,updated_at=now();
  end loop;
  update public.receiving_receipts set total_amount=v_total where id=v_id;
  if v_cash>0 then
    if p_cash_method not in ('CASH','KASPI','TRANSFER') then raise exception 'Неверный способ оплаты'; end if;
    if v_cash>v_total then raise exception 'Оплата больше суммы приёмки'; end if;
    insert into public.receiving_cash_transactions(workspace_id,tx_date,direction,method,category,amount,receipt_id,contractor_id,note,created_by)
    values(v_ws,p_date,'IN',p_cash_method,'RECEIPT_PAYMENT',v_cash,v_id,p_contractor_id,p_note,auth.uid());
  end if;
  return v_id;
end; $$;

create or replace function public.create_receiving_sale(p_date date,p_contractor_id uuid,p_buyer_name text,p_items jsonb,p_note text default null)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_id uuid; v_num bigint; r jsonb; v_total numeric:=0; v_cogs numeric:=0; v_avg numeric;
begin
  if v_ws is null then raise exception 'Нет доступа к складу'; end if;
  v_num:=public.next_receiving_sale_number(p_date);
  insert into public.receiving_sales(workspace_id,sale_number,sale_date,contractor_id,buyer_name,note,created_by)
  values(v_ws,v_num,p_date,p_contractor_id,nullif(trim(p_buyer_name),''),p_note,auth.uid()) returning id into v_id;
  for r in select * from jsonb_array_elements(p_items) loop
    perform pg_advisory_xact_lock(hashtextextended(v_ws::text||(r->>'product_id'),31));
    select case when quantity_kg>0 then cost_amount/quantity_kg else 0 end into v_avg from public.receiving_stock_balances where workspace_id=v_ws and product_id=(r->>'product_id')::uuid for update;
    if coalesce(v_avg,0)=0 and coalesce((r->>'price')::numeric,0)>=0 then v_avg:=coalesce(v_avg,0); end if;
    if not exists(select 1 from public.receiving_stock_balances where workspace_id=v_ws and product_id=(r->>'product_id')::uuid and quantity_kg+0.000001 >= (r->>'kg')::numeric) then raise exception 'Недостаточный остаток на Пункте приёмки для товара %',(r->>'product_id'); end if;
    insert into public.receiving_sale_items(workspace_id,sale_id,product_id,quantity_kg,unit_price,cogs_amount)
    values(v_ws,v_id,(r->>'product_id')::uuid,(r->>'kg')::numeric,(r->>'price')::numeric,round((r->>'kg')::numeric*coalesce(v_avg,0),2));
    update public.receiving_stock_balances set quantity_kg=quantity_kg-(r->>'kg')::numeric,cost_amount=greatest(0,cost_amount-round((r->>'kg')::numeric*coalesce(v_avg,0),2)),updated_at=now() where workspace_id=v_ws and product_id=(r->>'product_id')::uuid;
    v_total:=v_total+round((r->>'kg')::numeric*(r->>'price')::numeric,2); v_cogs:=v_cogs+round((r->>'kg')::numeric*coalesce(v_avg,0),2);
  end loop;
  update public.receiving_sales set total_amount=v_total,cogs_amount=v_cogs where id=v_id;
  return v_id;
end; $$;

create or replace function public.transfer_receiving_to_hangar(p_date date,p_items jsonb,p_note text default null)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_tid uuid; v_num bigint; v_total numeric:=0; v_op uuid; v_internal uuid; r jsonb; v_avg numeric; v_internal_items jsonb:='[]'::jsonb;
begin
  if v_ws is null then raise exception 'Нет доступа к складу'; end if;
  v_num:=public.next_receiving_transfer_number(p_date);
  insert into public.contractors(workspace_id,name) values(v_ws,'Пункт приёмки → Ангар') on conflict(workspace_id,lower(name)) do update set name=excluded.name returning id into v_internal;
  insert into public.receiving_transfers(workspace_id,transfer_number,transfer_date,note,created_by) values(v_ws,v_num,p_date,p_note,auth.uid()) returning id into v_tid;
  for r in select * from jsonb_array_elements(p_items) loop
    perform pg_advisory_xact_lock(hashtextextended(v_ws::text||(r->>'product_id'),31));
    select case when quantity_kg>0 then cost_amount/quantity_kg else 0 end into v_avg from public.receiving_stock_balances where workspace_id=v_ws and product_id=(r->>'product_id')::uuid for update;
    if not exists(select 1 from public.receiving_stock_balances where workspace_id=v_ws and product_id=(r->>'product_id')::uuid and quantity_kg+0.000001 >= (r->>'kg')::numeric) then raise exception 'Недостаточный остаток на Пункте приёмки'; end if;
    insert into public.receiving_transfer_items(workspace_id,transfer_id,product_id,quantity_kg,unit_cost) values(v_ws,v_tid,(r->>'product_id')::uuid,(r->>'kg')::numeric,round(coalesce(v_avg,0),2));
    update public.receiving_stock_balances set quantity_kg=quantity_kg-(r->>'kg')::numeric,cost_amount=greatest(0,cost_amount-round((r->>'kg')::numeric*coalesce(v_avg,0),2)),updated_at=now() where workspace_id=v_ws and product_id=(r->>'product_id')::uuid;
    v_total:=v_total+round((r->>'kg')::numeric*coalesce(v_avg,0),2);
    v_internal_items:=v_internal_items || jsonb_build_array(jsonb_build_object('product_id',r->>'product_id','kg',(r->>'kg')::numeric,'price',round(coalesce(v_avg,0),2)));
  end loop;
  select public.post_internal_transfer_operation(v_ws,p_date,v_internal,v_internal_items,p_note) into v_op;
  update public.receiving_transfer_items set hangar_operation_id=v_op where transfer_id=v_tid;
  update public.receiving_transfers set total_cost=v_total where id=v_tid;
  return v_tid;
end; $$;

create or replace function public.post_internal_transfer_operation(p_ws uuid,p_date date,p_contractor_id uuid,p_items jsonb,p_note text default null)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_id uuid; v_num bigint; r jsonb; begin
  perform public.ensure_member(p_ws); v_num:=public.next_operation_number(p_ws,p_date);
  insert into public.operations(workspace_id,operation_number,operation_date,type,role,contractor_id,created_by,note) values(p_ws,v_num,p_date,'ARRIVAL','ARRIVAL',p_contractor_id,auth.uid(),coalesce(p_note,'Перемещение из Пункта приёмки')) returning id into v_id;
  for r in select * from jsonb_array_elements(p_items) loop
    insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg,cogs_amount) values(p_ws,v_id,(r->>'product_id')::uuid,(r->>'kg')::numeric,(r->>'price')::numeric,0,0);
  end loop;
  return v_id;
end; $$;

-- Keep Angar reports financially clean: transfers add stock but are not procurement revenue/expense.
create or replace function public.rebuild_product_valuation(p_product_id uuid,p_workspace_id uuid) returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare r record; v_qty numeric(16,3):=0; v_cost numeric(18,2):=0; v_avg numeric(18,8):=0; v_cogs numeric(18,2):=0;
begin perform public.ensure_member(p_workspace_id); perform public.lock_product(p_workspace_id,p_product_id);
 for r in select o.id operation_id,o.type,o.role,o.operation_date,o.created_at,i.id item_id,i.quantity_kg,i.unit_price from public.operations o join public.operation_items i on i.operation_id=o.id where o.workspace_id=p_workspace_id and i.workspace_id=p_workspace_id and i.product_id=p_product_id order by o.operation_date,o.created_at,o.id loop
  if r.role in ('AUTO_REPLENISH','ARRIVAL') or r.type='ARRIVAL' then
    v_qty:=v_qty+r.quantity_kg; v_cost:=v_cost+round(r.quantity_kg*r.unit_price,2); v_cogs:=0;
  else
    if v_qty+0.000001 < r.quantity_kg then raise exception 'Недостаточный остаток товара % на операции %: доступно %, требуется %',p_product_id,r.operation_id,round(v_qty,3),round(r.quantity_kg,3); end if;
    if v_qty>0 then v_avg:=v_cost/v_qty; else v_avg:=0; end if;
    v_cogs:=round(r.quantity_kg*v_avg,2); v_qty:=v_qty-r.quantity_kg; v_cost:=greatest(0,v_cost-v_cogs);
  end if;
  update public.operation_items set cogs_amount=case when r.role='SHIPMENT' then v_cogs else 0 end where id=r.item_id;
 end loop;
 insert into public.inventory_balances(workspace_id,product_id,quantity_kg,cost_amount,updated_at) values(p_workspace_id,product_id,greatest(0,v_qty),greatest(0,v_cost),now()) on conflict(workspace_id,product_id) do update set quantity_kg=excluded.quantity_kg,cost_amount=excluded.cost_amount,updated_at=now();
end; $$;

-- Override the existing report RPC only to exclude internal transfers from financial arrival totals.
create or replace function public.get_profit_report(p_from date default null,p_to date default null) returns jsonb language plpgsql stable security invoker set search_path=public,pg_catalog as $$
declare v_workspace uuid:=public.current_workspace_id(); v_from date:=coalesce(p_from,'1900-01-01'::date); v_to date:=coalesce(p_to,current_date); v_result jsonb;
begin
with base as (select o.id,o.operation_date,o.type,o.role,o.status,o.contractor_id,c.name contractor_name,c.group_id,g.name group_name,oi.product_id,p.name product_name,oi.quantity_kg,oi.total_amount,coalesce(oi.cogs_amount,0) cogs_amount from public.operations o join public.operation_items oi on oi.operation_id=o.id and oi.workspace_id=v_workspace join public.products p on p.id=oi.product_id and p.workspace_id=v_workspace join public.contractors c on c.id=o.contractor_id and c.workspace_id=v_workspace left join public.contractor_groups g on g.id=c.group_id and g.workspace_id=v_workspace where o.workspace_id=v_workspace and o.status='CONFIRMED' and o.operation_date between v_from and v_to),
totals as (select coalesce(sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' and coalesce(note,'') not like 'Перемещение из Пункта приёмки%' then total_amount else 0 end),0) in_sum,coalesce(sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' and coalesce(note,'') not like 'Перемещение из Пункта приёмки%' then quantity_kg else 0 end),0) in_kg,count(distinct case when type='ARRIVAL' and role<>'AUTO_REPLENISH' and coalesce(note,'') not like 'Перемещение из Пункта приёмки%' then id end) in_count,coalesce(sum(case when type='SHIPMENT' then total_amount else 0 end),0) out_sum,coalesce(sum(case when type='SHIPMENT' then quantity_kg else 0 end),0) out_kg,count(distinct case when type='SHIPMENT' then id end) out_count,coalesce(sum(case when type='SHIPMENT' then cogs_amount else 0 end),0) cogs,coalesce(sum(case when type='SHIPMENT' then total_amount-cogs_amount else 0 end),0) profit from base),product_rows as (select product_id,product_name name,sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' and coalesce(note,'') not like 'Перемещение из Пункта приёмки%' then quantity_kg else 0 end) in_kg,sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' and coalesce(note,'') not like 'Перемещение из Пункта приёмки%' then total_amount else 0 end) in_sum,sum(case when type='SHIPMENT' then quantity_kg else 0 end) out_kg,sum(case when type='SHIPMENT' then total_amount else 0 end) out_sum,sum(case when type='SHIPMENT' then cogs_amount else 0 end) cogs from base group by product_id,product_name),client_rows as (select contractor_id,contractor_name name,group_id,group_name,sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' and coalesce(note,'') not like 'Перемещение из Пункта приёмки%' then total_amount else 0 end) in_sum,sum(case when type='SHIPMENT' then total_amount else 0 end) out_sum,sum(case when type='SHIPMENT' then cogs_amount else 0 end) cogs from base where role<>'AUTO_REPLENISH' and coalesce(note,'') not like 'Перемещение из Пункта приёмки%' group by contractor_id,contractor_name,group_id,group_name),group_rows as (select group_id,group_name name,sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' and coalesce(note,'') not like 'Перемещение из Пункта приёмки%' then total_amount else 0 end) in_sum,sum(case when type='SHIPMENT' then total_amount else 0 end) out_sum,sum(case when type='SHIPMENT' then cogs_amount else 0 end) cogs from base where role<>'AUTO_REPLENISH' and coalesce(note,'') not like 'Перемещение из Пункта приёмки%' and group_id is not null group by group_id,group_name),daily_rows as (select operation_date date,sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' and coalesce(note,'') not like 'Перемещение из Пункта приёмки%' then total_amount else 0 end) in_sum,sum(case when type='SHIPMENT' then total_amount else 0 end) out_sum from base group by operation_date)
select jsonb_build_object('totals',(select jsonb_build_object('in_sum',in_sum,'in_kg',in_kg,'in_count',in_count,'out_sum',out_sum,'out_kg',out_kg,'out_count',out_count,'cogs',cogs,'profit',profit,'margin',case when out_sum<>0 then (profit/out_sum)*100 else 0 end) from totals),'products',coalesce((select jsonb_agg(jsonb_build_object('name',name,'in_kg',in_kg,'in_sum',in_sum,'out_kg',out_kg,'out_sum',out_sum,'cogs',cogs,'profit',out_sum-cogs,'margin',case when out_sum<>0 then ((out_sum-cogs)/out_sum)*100 else 0 end) order by out_sum desc,name) from product_rows),'[]'::jsonb),'clients',coalesce((select jsonb_agg(jsonb_build_object('name',name,'group',group_name,'parent',group_name,'isGroup',false,'in_sum',in_sum,'out_sum',out_sum,'cogs',cogs,'profit',out_sum-cogs,'margin',case when out_sum<>0 then ((out_sum-cogs)/out_sum)*100 else 0 end) order by out_sum desc,name) from client_rows),'[]'::jsonb),'groups',coalesce((select jsonb_agg(jsonb_build_object('name',name,'isGroup',true,'in_sum',in_sum,'out_sum',out_sum,'cogs',cogs,'profit',out_sum-cogs,'margin',case when out_sum<>0 then ((out_sum-cogs)/out_sum)*100 else 0 end) order by out_sum desc,name) from group_rows),'[]'::jsonb),'daily',coalesce((select jsonb_agg(jsonb_build_object('date',to_char(date,'YYYY-MM-DD'),'in_sum',in_sum,'out_sum',out_sum) order by date) from daily_rows),'[]'::jsonb)) into v_result; return v_result; end; $$;


create or replace function public.set_receiving_loading_status(p_product_id uuid,p_status text) returns void language plpgsql security definer set search_path=public,pg_catalog as $$ begin if p_status not in ('READY','HOLD','CHECK') then raise exception 'Неверный статус'; end if; update public.receiving_stock_balances set loading_status=p_status,updated_at=now() where workspace_id=public.current_workspace_id() and product_id=p_product_id; end; $$;
create or replace function public.create_receiving_cash(p_date date,p_direction text,p_method text,p_category text,p_amount numeric,p_employee_id uuid default null,p_contractor_id uuid default null,p_note text default null) returns bigint language plpgsql security definer set search_path=public,pg_catalog as $$ declare v_id bigint; begin if p_direction not in ('IN','OUT') or p_method not in ('CASH','KASPI','TRANSFER') then raise exception 'Неверные параметры кассы'; end if; if p_amount<=0 then raise exception 'Сумма должна быть больше нуля'; end if; insert into public.receiving_cash_transactions(workspace_id,tx_date,direction,method,category,amount,employee_id,contractor_id,note,created_by) values(public.current_workspace_id(),p_date,p_direction,p_method,p_category,p_amount,p_employee_id,p_contractor_id,p_note,auth.uid()) returning id into v_id; return v_id; end; $$;
create or replace function public.create_receiving_employee(p_name text,p_phone text default null) returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$ declare v_id uuid; begin perform public.ensure_manager(); if nullif(trim(p_name),'') is null then raise exception 'Введите имя сотрудника'; end if; insert into public.employees(workspace_id,name,phone) values(public.current_workspace_id(),trim(p_name),nullif(trim(p_phone),'')) returning id into v_id; return v_id; end; $$;
create or replace function public.close_receiving_day(p_date date,p_actual_cash numeric,p_actual_kaspi numeric,p_actual_transfer numeric,p_reason text default null) returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$ declare v_id uuid; v_expected numeric; begin perform public.ensure_manager(); select coalesce(sum(case when direction='IN' then amount else -amount end),0) into v_expected from public.receiving_cash_transactions where workspace_id=public.current_workspace_id() and tx_date=p_date; insert into public.receiving_day_closings(workspace_id,close_date,expected_total,actual_cash,actual_kaspi,actual_transfer,variance,reason,status,closed_by,closed_at) values(public.current_workspace_id(),p_date,v_expected,coalesce(p_actual_cash,0),coalesce(p_actual_kaspi,0),coalesce(p_actual_transfer,0),(coalesce(p_actual_cash,0)+coalesce(p_actual_kaspi,0)+coalesce(p_actual_transfer,0))-v_expected,p_reason,'CLOSED',auth.uid(),now()) on conflict(workspace_id,close_date) do update set expected_total=excluded.expected_total,actual_cash=excluded.actual_cash,actual_kaspi=excluded.actual_kaspi,actual_transfer=excluded.actual_transfer,variance=excluded.variance,reason=excluded.reason,status='CLOSED',closed_by=auth.uid(),closed_at=now() returning id into v_id; return v_id; end; $$;
grant execute on function public.create_receiving_receipt(date,text,uuid,text,text,jsonb,text,text,numeric) to authenticated;
grant execute on function public.create_receiving_sale(date,uuid,text,jsonb,text) to authenticated;
grant execute on function public.transfer_receiving_to_hangar(date,jsonb,text) to authenticated;
grant execute on function public.post_internal_transfer_operation(uuid,date,uuid,jsonb,text) to authenticated;
grant execute on function public.set_receiving_loading_status(uuid,text) to authenticated;
grant execute on function public.create_receiving_cash(date,text,text,text,numeric,uuid,uuid,text) to authenticated;
grant execute on function public.create_receiving_employee(text,text) to authenticated;
grant execute on function public.close_receiving_day(date,numeric,numeric,numeric,text) to authenticated;

revoke insert,update,delete on public.receiving_receipts,public.receiving_receipt_items,public.receiving_stock_balances,public.receiving_sales,public.receiving_sale_items,public.receiving_transfers,public.receiving_transfer_items from authenticated;
revoke insert,update,delete on public.receiving_cash_transactions,public.receiving_day_closings from authenticated;
revoke insert,update,delete on public.employee_transactions from authenticated;
revoke insert,update,delete on public.employees from authenticated;
grant select on public.receiving_receipts,public.receiving_receipt_items,public.receiving_stock_balances,public.receiving_sales,public.receiving_sale_items,public.receiving_transfers,public.receiving_transfer_items,public.employees,public.employee_transactions,public.receiving_cash_transactions,public.receiving_day_closings to authenticated;

commit;
