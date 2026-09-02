begin;

create table if not exists public.point_expenses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  expense_date date not null,
  contractor_id uuid references public.contractors(id) on delete set null,
  description text not null default '',
  amount numeric(18,2) not null check(amount>=0),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists point_expenses_workspace_date_idx on public.point_expenses(workspace_id, expense_date, created_at desc);
create index if not exists point_expenses_workspace_contractor_idx on public.point_expenses(workspace_id, contractor_id, expense_date desc);

create table if not exists public.point_evening_checks (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  check_date date not null,
  opening_cash numeric(18,2) not null default 0,
  cash_brought numeric(18,2) not null default 0,
  actual_cash numeric(18,2),
  notes text not null default '',
  saved_by uuid references auth.users(id),
  saved_at timestamptz not null default now(),
  primary key(workspace_id, check_date)
);

alter table public.point_expenses enable row level security;
alter table public.point_evening_checks enable row level security;
create policy point_expenses_select on public.point_expenses for select to authenticated using(workspace_id=public.current_workspace_id());
create policy point_evening_checks_select on public.point_evening_checks for select to authenticated using(workspace_id=public.current_workspace_id());
revoke insert,update,delete on public.point_expenses from authenticated,anon;
revoke insert,update,delete on public.point_evening_checks from authenticated,anon;

create or replace function public.list_point_expenses(p_from date default null,p_to date default null)
returns jsonb language sql stable security invoker set search_path=public,pg_catalog as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',e.id,'date',e.expense_date,'contractor_id',e.contractor_id,
    'contractor_name',coalesce(c.name,'Без контрагента'),'description',e.description,'amount',e.amount,
    'created_at',e.created_at
  ) order by e.expense_date desc,e.created_at desc),'[]'::jsonb)
  from public.point_expenses e
  left join public.contractors c on c.id=e.contractor_id
  where e.workspace_id=public.current_workspace_id()
    and e.expense_date between coalesce(p_from,'1900-01-01'::date) and coalesce(p_to,current_date);
$$;

grant execute on function public.list_point_expenses(date,date) to authenticated;

create or replace function public.upsert_point_expense(
  p_id uuid default null,
  p_date date default current_date,
  p_contractor_id uuid default null,
  p_description text default '',
  p_amount numeric default 0
) returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_ws uuid:=public.current_workspace_id();
  v_id uuid;
begin
  if v_ws is null then raise exception 'Пользователь не авторизован'; end if;
  if p_date>current_date then raise exception 'Дата расхода не может быть в будущем'; end if;
  if p_amount<0 then raise exception 'Сумма расхода не может быть отрицательной'; end if;
  if p_contractor_id is not null and not exists(select 1 from public.contractors where id=p_contractor_id and workspace_id=v_ws) then
    raise exception 'Контрагент расхода не найден';
  end if;
  if p_id is null then
    insert into public.point_expenses(workspace_id,expense_date,contractor_id,description,amount,created_by,updated_at)
    values(v_ws,p_date,p_contractor_id,trim(coalesce(p_description,'')),round(p_amount,2),auth.uid(),now()) returning id into v_id;
    insert into public.audit_log(workspace_id,action,user_id,new_data,details)
    values(v_ws,'ДОБАВЛЕН РАСХОД',auth.uid(),jsonb_build_object('id',v_id,'date',p_date,'contractor_id',p_contractor_id,'description',p_description,'amount',p_amount),'Расход пункта приёмки');
  else
    update public.point_expenses
      set expense_date=p_date,contractor_id=p_contractor_id,description=trim(coalesce(p_description,'')),amount=round(p_amount,2),updated_at=now()
      where id=p_id and workspace_id=v_ws;
    if not found then raise exception 'Расход не найден'; end if;
    v_id:=p_id;
    insert into public.audit_log(workspace_id,action,user_id,new_data,details)
    values(v_ws,'ИЗМЕНЁН РАСХОД',auth.uid(),jsonb_build_object('id',v_id,'date',p_date,'contractor_id',p_contractor_id,'description',p_description,'amount',p_amount),'Изменение расхода');
  end if;
  return v_id;
end; $$;

grant execute on function public.upsert_point_expense(uuid,date,uuid,text,numeric) to authenticated;

create or replace function public.delete_point_expense(p_id uuid) returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_old public.point_expenses%rowtype;
begin
  select * into v_old from public.point_expenses where id=p_id and workspace_id=v_ws for update;
  if not found then raise exception 'Расход не найден'; end if;
  delete from public.point_expenses where id=p_id and workspace_id=v_ws;
  insert into public.audit_log(workspace_id,action,user_id,old_data,details)
  values(v_ws,'УДАЛЁН РАСХОД',auth.uid(),jsonb_build_object('id',v_old.id,'date',v_old.expense_date,'contractor_id',v_old.contractor_id,'description',v_old.description,'amount',v_old.amount),'Удаление расхода');
end; $$;

grant execute on function public.delete_point_expense(uuid) to authenticated;

create or replace function public.save_point_evening_check(
  p_date date,
  p_opening_cash numeric default 0,
  p_cash_brought numeric default 0,
  p_actual_cash numeric default null,
  p_notes text default ''
) returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_expense_total numeric(18,2); v_expected numeric(18,2); v_diff numeric(18,2);
begin
  if v_ws is null then raise exception 'Пользователь не авторизован'; end if;
  if p_date>current_date then raise exception 'Дата сверки не может быть в будущем'; end if;
  select coalesce(sum(amount),0) into v_expense_total from public.point_expenses where workspace_id=v_ws and expense_date=p_date;
  v_expected:=round(coalesce(p_opening_cash,0)+coalesce(p_cash_brought,0)-v_expense_total,2);
  v_diff:=case when p_actual_cash is null then null else round(p_actual_cash-v_expected,2) end;
  insert into public.point_evening_checks(workspace_id,check_date,opening_cash,cash_brought,actual_cash,notes,saved_by,saved_at)
  values(v_ws,p_date,round(coalesce(p_opening_cash,0),2),round(coalesce(p_cash_brought,0),2),p_actual_cash,coalesce(p_notes,''),auth.uid(),now())
  on conflict(workspace_id,check_date) do update set opening_cash=excluded.opening_cash,cash_brought=excluded.cash_brought,actual_cash=excluded.actual_cash,notes=excluded.notes,saved_by=auth.uid(),saved_at=now();
  insert into public.audit_log(workspace_id,action,user_id,new_data,details)
  values(v_ws,'СВЕРКА ПУНКТА',auth.uid(),jsonb_build_object('date',p_date,'opening_cash',p_opening_cash,'cash_brought',p_cash_brought,'expenses',v_expense_total,'actual_cash',p_actual_cash,'expected_cash',v_expected,'difference',v_diff),'Вечерняя сверка пункта приёмки');
  return jsonb_build_object('date',p_date,'opening_cash',round(coalesce(p_opening_cash,0),2),'cash_brought',round(coalesce(p_cash_brought,0),2),'expenses',v_expense_total,'expected_cash',v_expected,'actual_cash',p_actual_cash,'difference',v_diff);
end; $$;

grant execute on function public.save_point_evening_check(date,numeric,numeric,numeric,text) to authenticated;

create or replace function public.get_point_evening_data(p_date date default current_date) returns jsonb language plpgsql stable security invoker set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_check public.point_evening_checks%rowtype; v_expense_total numeric; v_expected numeric; v_diff numeric; v_expenses jsonb;
begin
  select * into v_check from public.point_evening_checks where workspace_id=v_ws and check_date=p_date;
  select coalesce(sum(amount),0),coalesce(jsonb_agg(jsonb_build_object('id',e.id,'contractor_id',e.contractor_id,'contractor_name',coalesce(c.name,'Без контрагента'),'description',e.description,'amount',e.amount) order by e.created_at desc),'[]'::jsonb)
    into v_expense_total,v_expenses
    from public.point_expenses e left join public.contractors c on c.id=e.contractor_id
   where e.workspace_id=v_ws and e.expense_date=p_date;
  v_expected:=round(coalesce(v_check.opening_cash,0)+coalesce(v_check.cash_brought,0)-v_expense_total,2);
  v_diff:=case when v_check.actual_cash is null then null else round(v_check.actual_cash-v_expected,2) end;
  return jsonb_build_object(
    'check',case when v_check.workspace_id is null then null else jsonb_build_object('opening_cash',v_check.opening_cash,'cash_brought',v_check.cash_brought,'actual_cash',v_check.actual_cash,'notes',v_check.notes,'saved_at',v_check.saved_at) end,
    'expenses',v_expenses,'expense_total',v_expense_total,'expected_cash',v_expected,'difference',v_diff
  );
end; $$;

grant execute on function public.get_point_evening_data(date) to authenticated;

commit;
