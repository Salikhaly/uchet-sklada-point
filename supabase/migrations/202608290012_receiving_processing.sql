begin;

-- Receiving-point processing: employee takes input material, returns processed output.
-- This module is isolated from the existing Hangar logic.
create table if not exists public.receiving_processing_operations(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  process_number bigint not null,
  process_date date not null,
  employee_id uuid not null references public.employees(id),
  status text not null default 'CONFIRMED' check(status in ('CONFIRMED','CANCELLED')),
  note text,
  input_cost numeric(18,2) not null default 0,
  output_value numeric(18,2) not null default 0,
  employee_pay numeric(18,2) not null default 0,
  estimated_result numeric(18,2) not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index if not exists receiving_processing_number_uq on public.receiving_processing_operations(workspace_id,process_date,process_number);

create table if not exists public.receiving_processing_inputs(
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  processing_id uuid not null references public.receiving_processing_operations(id) on delete cascade,
  product_id uuid not null references public.products(id),
  quantity_kg numeric(16,3) not null check(quantity_kg>0),
  unit_cost numeric(14,2) not null check(unit_cost>=0),
  total_cost numeric(18,2) generated always as(round(quantity_kg*unit_cost,2)) stored
);

create table if not exists public.receiving_processing_outputs(
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  processing_id uuid not null references public.receiving_processing_operations(id) on delete cascade,
  product_id uuid not null references public.products(id),
  quantity_kg numeric(16,3) not null check(quantity_kg>0),
  unit_value numeric(14,2) not null check(unit_value>=0),
  total_value numeric(18,2) generated always as(round(quantity_kg*unit_value,2)) stored
);

create index if not exists receiving_processing_inputs_idx on public.receiving_processing_inputs(workspace_id,product_id,processing_id);
create index if not exists receiving_processing_outputs_idx on public.receiving_processing_outputs(workspace_id,product_id,processing_id);

alter table public.receiving_processing_operations enable row level security;
alter table public.receiving_processing_inputs enable row level security;
alter table public.receiving_processing_outputs enable row level security;
create policy receiving_processing_operations_all on public.receiving_processing_operations for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy receiving_processing_inputs_all on public.receiving_processing_inputs for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());
create policy receiving_processing_outputs_all on public.receiving_processing_outputs for all to authenticated using(workspace_id=public.current_workspace_id()) with check(workspace_id=public.current_workspace_id());

create or replace function public.next_receiving_processing_number(p_date date) returns bigint language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_n bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_ws::text||':processing:'||p_date::text,31));
  select coalesce(max(process_number),0)+1 into v_n from public.receiving_processing_operations where workspace_id=v_ws and process_date=p_date;
  return v_n;
end; $$;

grant execute on function public.next_receiving_processing_number(date) to authenticated;

create or replace function public.create_receiving_processing(
  p_date date,
  p_employee_id uuid,
  p_inputs jsonb,
  p_outputs jsonb,
  p_employee_pay numeric default 0,
  p_pay_method text default 'CASH',
  p_note text default null
) returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_ws uuid:=public.current_workspace_id(); v_id uuid; v_num bigint; r jsonb;
  v_input_cost numeric:=0; v_output_value numeric:=0; v_pay numeric:=round(coalesce(p_employee_pay,0),2);
  v_avg numeric; v_qty numeric; v_total numeric; v_result numeric;
  v_cash_id bigint;
begin
  if v_ws is null then raise exception 'Нет доступа к складу'; end if;
  if p_employee_id is null then raise exception 'Выберите сотрудника'; end if;
  if coalesce(jsonb_array_length(p_inputs),0)=0 then raise exception 'Не указано сырьё'; end if;
  if coalesce(jsonb_array_length(p_outputs),0)=0 then raise exception 'Не указан результат переработки'; end if;
  if v_pay < 0 then raise exception 'Оплата сотрудника не может быть отрицательной'; end if;
  if p_pay_method not in ('CASH','KASPI','TRANSFER') then raise exception 'Неверный способ оплаты переработки'; end if;

  v_num:=public.next_receiving_processing_number(p_date);
  insert into public.receiving_processing_operations(workspace_id,process_number,process_date,employee_id,note,employee_pay,created_by)
  values(v_ws,v_num,p_date,p_employee_id,p_note,v_pay,auth.uid()) returning id into v_id;

  -- Consume input from receiving stock at the average cost at the moment of processing.
  for r in select * from jsonb_array_elements(p_inputs) loop
    perform pg_advisory_xact_lock(hashtextextended(v_ws::text||(r->>'product_id'),31));
    select quantity_kg,case when quantity_kg>0 then round(cost_amount/quantity_kg,2) else 0 end into v_qty,v_avg
      from public.receiving_stock_balances where workspace_id=v_ws and product_id=(r->>'product_id')::uuid for update;
    if coalesce(v_qty,0)+0.000001 < (r->>'kg')::numeric then
      raise exception 'Недостаточный остаток сырья для переработки';
    end if;
    v_total:=round((r->>'kg')::numeric*coalesce(v_avg,0),2);
    insert into public.receiving_processing_inputs(workspace_id,processing_id,product_id,quantity_kg,unit_cost)
      values(v_ws,v_id,(r->>'product_id')::uuid,(r->>'kg')::numeric,coalesce(v_avg,0));
    update public.receiving_stock_balances
      set quantity_kg=quantity_kg-(r->>'kg')::numeric,
          cost_amount=greatest(0,cost_amount-v_total),
          updated_at=now()
      where workspace_id=v_ws and product_id=(r->>'product_id')::uuid;
    v_input_cost:=v_input_cost+v_total;
  end loop;

  -- Add processed output into the receiving stock. The agreed return value becomes its book cost.
  for r in select * from jsonb_array_elements(p_outputs) loop
    v_total:=round((r->>'kg')::numeric*(r->>'unit_value')::numeric,2);
    insert into public.receiving_processing_outputs(workspace_id,processing_id,product_id,quantity_kg,unit_value)
      values(v_ws,v_id,(r->>'product_id')::uuid,(r->>'kg')::numeric,(r->>'unit_value')::numeric);
    perform pg_advisory_xact_lock(hashtextextended(v_ws::text||(r->>'product_id'),31));
    insert into public.receiving_stock_balances(workspace_id,product_id,quantity_kg,cost_amount,updated_at)
      values(v_ws,(r->>'product_id')::uuid,(r->>'kg')::numeric,v_total,now())
    on conflict(workspace_id,product_id) do update
      set quantity_kg=receiving_stock_balances.quantity_kg+excluded.quantity_kg,
          cost_amount=receiving_stock_balances.cost_amount+excluded.cost_amount,
          updated_at=now();
    v_output_value:=v_output_value+v_total;
  end loop;

  v_result:=round(v_output_value-v_input_cost-v_pay,2);
  update public.receiving_processing_operations
    set input_cost=v_input_cost,output_value=v_output_value,employee_pay=v_pay,estimated_result=v_result
    where id=v_id;

  if v_pay>0 then
    insert into public.employee_transactions(workspace_id,employee_id,tx_date,tx_type,amount,method,note,created_by)
      values(v_ws,p_employee_id,p_date,'PROCESSING_PAY',v_pay,p_pay_method,coalesce(p_note,'Оплата переработки'),auth.uid());
    insert into public.receiving_cash_transactions(workspace_id,tx_date,direction,method,category,amount,employee_id,note,created_by)
      values(v_ws,p_date,'OUT',p_pay_method,'PROCESSING_PAY',v_pay,p_employee_id,coalesce(p_note,'Оплата переработки'),auth.uid()) returning id into v_cash_id;
    update public.employee_transactions et set cash_transaction_id=v_cash_id where et.id=(select max(id) from public.employee_transactions where workspace_id=v_ws and employee_id=p_employee_id and tx_type='PROCESSING_PAY');
  end if;

  return v_id;
end; $$;
grant execute on function public.create_receiving_processing(date,uuid,jsonb,jsonb,numeric,text,text) to authenticated;

-- Read model for processing summary.
create or replace view public.receiving_processing_summary as
select o.workspace_id,o.id,o.process_number,o.process_date,o.employee_id,e.name employee_name,o.input_cost,o.output_value,o.employee_pay,o.estimated_result,o.status,o.note
from public.receiving_processing_operations o join public.employees e on e.id=o.employee_id and e.workspace_id=o.workspace_id;
grant select on public.receiving_processing_summary to authenticated;

commit;
