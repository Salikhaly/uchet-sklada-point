-- Блок «Зарплата» в Точке: выплаты сотрудникам пишутся как расходы кассы
-- (статьи «Зарплата», «Аванс» или любая другая) — значит, сами попадают
-- в вечернюю сверку кассы и в старые отчёты.

-- Записать выплату сотруднику на любую (не закрытую) дату.
-- Если сводки дня ещё нет — создаёт её с остатком кассы от последней сводки,
-- как это делает вечерний экран по умолчанию.
create or replace function public.point_pay_employee(
  p_date date, p_employee_id uuid, p_category text, p_amount numeric, p_comment text default null
) returns uuid
language plpgsql security definer set search_path to 'public','pg_catalog'
as $$
declare
  v_ws uuid := public.current_point_workspace_id();
  v_summary uuid; v_status text; v_opening numeric;
begin
  perform public.ensure_point_member();
  if p_employee_id is null then raise exception 'Выберите сотрудника'; end if;
  if p_date is null or p_date > current_date then raise exception 'Дата не может быть в будущем'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'Сумма должна быть больше нуля'; end if;

  -- «Зарплата» и «Аванс» заводим как статьи, если их вдруг нет
  if lower(trim(coalesce(p_category,''))) in ('зарплата','аванс')
     and not exists (select 1 from public.point_expense_categories where workspace_id=v_ws and active and lower(name)=lower(trim(p_category))) then
    perform public.point_upsert_expense_category(initcap(trim(p_category)));
  end if;

  select id, status into v_summary, v_status
  from public.point_evening_summaries where workspace_id=v_ws and summary_date=p_date;
  if v_status = 'CLOSED' then
    raise exception 'День % закрыт. Откройте его заново на вкладке «Дни», чтобы добавить выплату.', to_char(p_date,'DD.MM.YYYY');
  end if;

  if v_summary is null then
    select coalesce(actual_cash,0) into v_opening
    from public.point_evening_summaries
    where workspace_id=v_ws and summary_date<p_date and actual_cash is not null
    order by summary_date desc limit 1;
    insert into public.point_evening_summaries(workspace_id,summary_date,opening_cash,brought_cash,created_by,updated_by)
    values (v_ws,p_date,coalesce(v_opening,0),0,auth.uid(),auth.uid())
    on conflict (workspace_id,summary_date) do nothing;
    select id, status into v_summary, v_status
    from public.point_evening_summaries where workspace_id=v_ws and summary_date=p_date;
    if v_status = 'CLOSED' then raise exception 'День уже закрыт'; end if;
  end if;

  return public.point_add_evening_expense(v_summary, p_employee_id, p_category, p_comment, p_amount, false);
end $$;

-- Все расходы с привязкой к сотруднику за период (клиент сам делит на аванс / зарплату / прочее).
create or replace function public.point_get_payroll(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path to 'public','pg_catalog'
as $$
declare v_ws uuid := public.current_point_workspace_id();
begin
  perform public.ensure_point_member();
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Неверный период'; end if;
  if p_to - p_from > 400 then raise exception 'Период слишком большой'; end if;
  return jsonb_build_object('entries', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',e.id,'date',s.summary_date,'employee_id',e.employee_id,'employee_name',pe.name,
      'category',e.category,'amount',e.amount,'comment',e.comment,'is_loan',e.is_loan,'closed',s.status='CLOSED'
    ) order by s.summary_date, e.created_at)
    from public.point_evening_expenses e
    join public.point_evening_summaries s on s.id=e.summary_id
    left join public.point_employees pe on pe.id=e.employee_id
    where e.workspace_id=v_ws and e.employee_id is not null and s.summary_date between p_from and p_to
  ),'[]'::jsonb));
end $$;

revoke all on function public.point_pay_employee(date,uuid,text,numeric,text) from public, anon;
revoke all on function public.point_get_payroll(date,date) from public, anon;
grant execute on function public.point_pay_employee(date,uuid,text,numeric,text) to authenticated, service_role;
grant execute on function public.point_get_payroll(date,date) to authenticated, service_role;
