-- Блок «Зарплата»: возможность убрать ненужных сотрудников (Тест, Начальство и т.п.)
-- из экрана зарплаты. Флаг хранится в базе, поэтому одинаков на всех устройствах.
-- Сотрудник остаётся активным везде (вечер, расходы, бот) — скрывается только в «Зарплате».
alter table public.point_employees add column if not exists hide_in_payroll boolean not null default false;

create or replace function public.point_set_employee_payroll_hidden(p_employee_id uuid, p_hidden boolean)
returns void
language plpgsql security definer set search_path to 'public','pg_catalog'
as $$
declare v_ws uuid := public.current_point_workspace_id();
begin
  perform public.ensure_point_member();
  update public.point_employees set hide_in_payroll = coalesce(p_hidden,false)
  where id = p_employee_id and workspace_id = v_ws;
  if not found then raise exception 'Сотрудник не найден'; end if;
end $$;

create or replace function public.point_get_payroll(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path to 'public','pg_catalog'
as $$
declare v_ws uuid := public.current_point_workspace_id();
begin
  perform public.ensure_point_member();
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Неверный период'; end if;
  if p_to - p_from > 400 then raise exception 'Период слишком большой'; end if;
  return jsonb_build_object(
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',e.id,'date',s.summary_date,'employee_id',e.employee_id,'employee_name',pe.name,
        'category',e.category,'amount',e.amount,'comment',e.comment,'is_loan',e.is_loan,'closed',s.status='CLOSED'
      ) order by s.summary_date, e.created_at)
      from public.point_evening_expenses e
      join public.point_evening_summaries s on s.id=e.summary_id
      left join public.point_employees pe on pe.id=e.employee_id
      where e.workspace_id=v_ws and e.employee_id is not null and s.summary_date between p_from and p_to
    ),'[]'::jsonb),
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object('id',pe.id,'name',pe.name,'hidden',pe.hide_in_payroll) order by pe.name)
      from public.point_employees pe where pe.workspace_id=v_ws and pe.active
    ),'[]'::jsonb)
  );
end $$;

revoke all on function public.point_set_employee_payroll_hidden(uuid,boolean) from public, anon;
grant execute on function public.point_set_employee_payroll_hidden(uuid,boolean) to authenticated, service_role;
grant execute on function public.point_get_payroll(date,date) to authenticated, service_role;
