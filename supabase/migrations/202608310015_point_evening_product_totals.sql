begin;

create table if not exists public.point_evening_product_totals (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  check_date date not null,
  product_id uuid not null references public.products(id) on delete cascade,
  total_kg numeric(18,3) not null default 0 check(total_kg>=0),
  total_amount numeric(18,2) not null default 0 check(total_amount>=0),
  out_kg numeric(18,3) not null default 0 check(out_kg>=0),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key(workspace_id,check_date,product_id)
);
create index if not exists point_evening_product_totals_idx on public.point_evening_product_totals(workspace_id,check_date);

alter table public.point_evening_product_totals enable row level security;
drop policy if exists point_evening_product_totals_select on public.point_evening_product_totals;
create policy point_evening_product_totals_select on public.point_evening_product_totals
  for select to authenticated using(workspace_id=public.current_workspace_id());
revoke insert,update,delete on public.point_evening_product_totals from authenticated,anon;

create or replace function public.save_point_evening_entries(
  p_date date,
  p_entries jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_ws uuid:=public.current_workspace_id();
  r jsonb;
  v_pid uuid;
  v_name text;
  v_kg numeric(18,3);
  v_amount numeric(18,2);
  v_out numeric(18,3);
  v_result jsonb:='[]'::jsonb;
begin
  if v_ws is null then raise exception 'Пользователь не авторизован'; end if;
  if p_date>current_date then raise exception 'Дата не может быть в будущем'; end if;

  delete from public.point_evening_product_totals where workspace_id=v_ws and check_date=p_date;

  for r in select value from jsonb_array_elements(coalesce(p_entries,'[]'::jsonb)) loop
    v_pid:=(r->>'product_id')::uuid;
    v_kg:=round(coalesce((r->>'total_kg')::numeric,0),3);
    v_amount:=round(coalesce((r->>'total_amount')::numeric,0),2);
    v_out:=round(coalesce((r->>'out_kg')::numeric,0),3);
    if v_kg<0 or v_amount<0 or v_out<0 then raise exception 'Итоги товара не могут быть отрицательными'; end if;
    select name into v_name from public.products where id=v_pid and workspace_id=v_ws and status='ACTIVE';
    if v_name is null then raise exception 'Товар для вечерней записи не найден'; end if;
    insert into public.point_evening_product_totals(workspace_id,check_date,product_id,total_kg,total_amount,out_kg,updated_by,updated_at)
    values(v_ws,p_date,v_pid,v_kg,v_amount,v_out,auth.uid(),now());
    v_result:=v_result||jsonb_build_object('product_id',v_pid,'product_name',v_name,'total_kg',v_kg,'total_amount',v_amount,'out_kg',v_out);
  end loop;

  insert into public.audit_log(workspace_id,action,user_id,new_data,details)
  values(v_ws,'ВЕЧЕРНИЕ ИТОГИ ПО ТОВАРАМ',auth.uid(),jsonb_build_object('date',p_date,'entries',v_result),'Общие итоги из вечерней записи пункта');

  return jsonb_build_object('date',p_date,'entries',v_result);
end; $$;

grant execute on function public.save_point_evening_entries(date,jsonb) to authenticated;

create or replace function public.get_point_evening_data(p_date date default current_date) returns jsonb
language plpgsql stable security invoker set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_check public.point_evening_checks%rowtype; v_expense_total numeric; v_expected numeric; v_diff numeric; v_expenses jsonb; v_entries jsonb;
begin
  select * into v_check from public.point_evening_checks where workspace_id=v_ws and check_date=p_date;
  select coalesce(sum(amount),0),coalesce(jsonb_agg(jsonb_build_object('id',e.id,'contractor_id',e.contractor_id,'contractor_name',coalesce(c.name,'Без контрагента'),'description',e.description,'amount',e.amount) order by e.created_at desc),'[]'::jsonb)
    into v_expense_total,v_expenses
    from public.point_expenses e left join public.contractors c on c.id=e.contractor_id
   where e.workspace_id=v_ws and e.expense_date=p_date;
  select coalesce(jsonb_agg(jsonb_build_object('product_id',t.product_id,'product_name',p.name,'total_kg',t.total_kg,'total_amount',t.total_amount,'out_kg',t.out_kg) order by p.sort_order,p.name),'[]'::jsonb)
    into v_entries
    from public.point_evening_product_totals t
    join public.products p on p.id=t.product_id
   where t.workspace_id=v_ws and t.check_date=p_date;
  v_expected:=round(coalesce(v_check.opening_cash,0)+coalesce(v_check.cash_brought,0)-v_expense_total,2);
  v_diff:=case when v_check.actual_cash is null then null else round(v_check.actual_cash-v_expected,2) end;
  return jsonb_build_object(
    'check',case when v_check.workspace_id is null then null else jsonb_build_object('opening_cash',v_check.opening_cash,'cash_brought',v_check.cash_brought,'actual_cash',v_check.actual_cash,'notes',v_check.notes,'saved_at',v_check.saved_at) end,
    'expenses',v_expenses,'expense_total',v_expense_total,'expected_cash',v_expected,'difference',v_diff,'entries',v_entries
  );
end; $$;

grant execute on function public.get_point_evening_data(date) to authenticated;

commit;
