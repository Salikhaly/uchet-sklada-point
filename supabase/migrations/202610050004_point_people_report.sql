-- Отчёт «Люди»: кто сколько взял за период (аванс / зарплата / прочие расходы / долги).
-- Заменяет блок employees из point_get_report, где суммы по сотрудникам считались
-- за всё время, а не за выбранный период (фильтр по дате стоял не там).
-- Строки со всеми расходами периода по сотрудникам; расходы без сотрудника — отдельной строкой,
-- поэтому сумма «Всего» по людям сходится с общими расходами периода.
create or replace function public.point_get_people_report(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path to 'public','pg_catalog'
as $$
declare v_ws uuid := public.current_point_workspace_id();
begin
  perform public.ensure_point_member();
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Неверный период'; end if;
  return coalesce((
    with ex as (
      select e.id, e.employee_id, e.category, e.amount, e.comment, e.is_loan, e.created_at, s.summary_date
      from public.point_evening_expenses e
      join public.point_evening_summaries s on s.id = e.summary_id
      where e.workspace_id = v_ws and s.summary_date between p_from and p_to
    ), per as (
      select pe.id as employee_id, pe.name::text as name, pe.hide_in_payroll as hidden,
        coalesce(sum(ex.amount) filter (where not ex.is_loan and lower(trim(ex.category)) = 'аванс'),0) as advance,
        coalesce(sum(ex.amount) filter (where not ex.is_loan and lower(trim(ex.category)) = 'зарплата'),0) as salary,
        coalesce(sum(ex.amount) filter (where not ex.is_loan and lower(trim(ex.category)) not in ('аванс','зарплата')),0) as other,
        coalesce(sum(ex.amount) filter (where ex.is_loan),0) as loan_given,
        coalesce(sum(ex.amount),0) as total,
        (select coalesce(sum(r.amount),0) from public.point_loan_repayments r
           join public.point_evening_expenses e2 on e2.id = r.expense_id
           where e2.employee_id = pe.id and r.workspace_id = v_ws and r.repay_date between p_from and p_to) as repaid,
        (select coalesce(sum(e3.amount - coalesce(rp.paid,0)),0) from public.point_evening_expenses e3
           left join (select expense_id, sum(amount) as paid from public.point_loan_repayments group by expense_id) rp on rp.expense_id = e3.id
           where e3.employee_id = pe.id and e3.workspace_id = v_ws and e3.is_loan) as debt_remaining,
        coalesce(jsonb_agg(jsonb_build_object('date',ex.summary_date,'category',ex.category,'amount',ex.amount,'comment',ex.comment,'is_loan',ex.is_loan)
          order by ex.summary_date, ex.created_at) filter (where ex.id is not null),'[]'::jsonb) as items
      from public.point_employees pe
      left join ex on ex.employee_id = pe.id
      where pe.workspace_id = v_ws
      group by pe.id, pe.name, pe.hide_in_payroll
    ), orphan as (
      select null::uuid as employee_id, 'Без сотрудника'::text as name, false as hidden,
        coalesce(sum(ex.amount) filter (where not ex.is_loan and lower(trim(ex.category)) = 'аванс'),0) as advance,
        coalesce(sum(ex.amount) filter (where not ex.is_loan and lower(trim(ex.category)) = 'зарплата'),0) as salary,
        coalesce(sum(ex.amount) filter (where not ex.is_loan and lower(trim(ex.category)) not in ('аванс','зарплата')),0) as other,
        coalesce(sum(ex.amount) filter (where ex.is_loan),0) as loan_given,
        coalesce(sum(ex.amount),0) as total,
        0::numeric as repaid, 0::numeric as debt_remaining,
        coalesce(jsonb_agg(jsonb_build_object('date',ex.summary_date,'category',ex.category,'amount',ex.amount,'comment',ex.comment,'is_loan',ex.is_loan)
          order by ex.summary_date, ex.created_at),'[]'::jsonb) as items
      from ex where ex.employee_id is null
      having count(*) > 0
    )
    select jsonb_agg(jsonb_build_object(
      'employee_id', q.employee_id, 'name', q.name, 'hidden', q.hidden,
      'advance', q.advance, 'salary', q.salary, 'other', q.other, 'loan_given', q.loan_given,
      'total', q.total, 'repaid', q.repaid, 'debt_remaining', q.debt_remaining, 'items', q.items
    ) order by q.total desc, q.name)
    from (select * from per union all select * from orphan) q
    where q.total <> 0 or q.repaid <> 0 or q.debt_remaining <> 0
  ), '[]'::jsonb);
end $$;

revoke all on function public.point_get_people_report(date,date) from public, anon;
grant execute on function public.point_get_people_report(date,date) to authenticated, service_role;
