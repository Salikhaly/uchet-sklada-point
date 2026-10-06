-- Для графиков «Закуп по дням» и «Средняя цена металла по дням» в отчёте
-- Точки не хватало кг закупа за каждый день (была только сумма в тенге).
-- Добавляем purchase_kg в days[], остальной RPC не трогаем.
create or replace function public.point_get_report(p_from date, p_to date)
returns jsonb
language plpgsql security definer set search_path to 'public','pg_catalog'
as $function$
declare v_ws uuid:=public.current_point_workspace_id(); v_result jsonb;
begin
  perform public.ensure_point_member();
  if p_from>p_to then raise exception 'Неверный период'; end if;

  select jsonb_build_object(
    'totals',jsonb_build_object(
      'purchase_kg',coalesce(sum(case when o.role='ARRIVAL' then oi.quantity_kg else 0 end),0),
      'purchase_amount',coalesce(sum(case when o.role='ARRIVAL' then oi.total_amount else 0 end),0),
      'shipment_kg',coalesce(sum(case when o.role='SHIPMENT' and o.note not like '[SALE]%' and o.note not like '[TRANSFER_TO_ANGAR]%' then oi.quantity_kg else 0 end),0),
      'shipment_amount',coalesce(sum(case when o.role='SHIPMENT' and o.note not like '[SALE]%' and o.note not like '[TRANSFER_TO_ANGAR]%' then oi.total_amount else 0 end),0),
      'sale_kg',coalesce(sum(case when o.note like '[SALE]%' then oi.quantity_kg else 0 end),0),
      'sale_amount',coalesce(sum(case when o.note like '[SALE]%' then oi.total_amount else 0 end),0),
      'transfer_kg',coalesce(sum(case when o.note like '[TRANSFER_TO_ANGAR]%' then oi.quantity_kg else 0 end),0),
      'cogs',coalesce(sum(case when o.role='SHIPMENT' and o.note not like '[SALE]%' and o.note not like '[TRANSFER_TO_ANGAR]%' then oi.cogs_amount else 0 end),0),
      'sale_cogs',coalesce(sum(case when o.note like '[SALE]%' then oi.cogs_amount else 0 end),0),
      'expense_amount',coalesce((select sum(e.amount) from public.point_evening_expenses e join public.point_evening_summaries s on s.id=e.summary_id where e.workspace_id=v_ws and s.summary_date between p_from and p_to),0),
      'loan_given_amount',coalesce((select sum(e.amount) from public.point_evening_expenses e join public.point_evening_summaries s on s.id=e.summary_id where e.workspace_id=v_ws and s.summary_date between p_from and p_to and e.is_loan),0),
      'repayment_amount',coalesce((select sum(r.amount) from public.point_loan_repayments r where r.workspace_id=v_ws and r.repay_date between p_from and p_to),0),
      'brought_cash',coalesce((select sum(s.brought_cash) from public.point_evening_summaries s where s.workspace_id=v_ws and s.summary_date between p_from and p_to),0),
      'opening_cash_first',(select s.opening_cash from public.point_evening_summaries s where s.workspace_id=v_ws and s.summary_date>=p_from and s.opening_cash is not null order by s.summary_date limit 1),
      'actual_cash_last',(select s.actual_cash from public.point_evening_summaries s where s.workspace_id=v_ws and s.summary_date<=p_to and s.actual_cash is not null order by s.summary_date desc limit 1),
      'days_total',(p_to-p_from+1),
      'days_closed',(select count(*) from public.point_evening_summaries s where s.workspace_id=v_ws and s.summary_date between p_from and p_to and s.status='CLOSED'),
      'days_variance',(select count(*) from public.point_evening_summaries s where s.workspace_id=v_ws and s.summary_date between p_from and p_to and s.variance is not null and s.variance<>0)
    ),
    'products',coalesce((select jsonb_agg(x order by coalesce((x->>'sort_order')::int,999999),(x->>'name')) from (select jsonb_build_object('name',p.name,'category',p.category,'sort_order',p.sort_order,'stock_kg',coalesce(i.quantity_kg,0),'purchase_kg',coalesce(sum(case when o.role='ARRIVAL' then oi.quantity_kg else 0 end),0),'shipment_kg',coalesce(sum(case when o.role='SHIPMENT' and o.note not like '[SALE]%' and o.note not like '[TRANSFER_TO_ANGAR]%' then oi.quantity_kg else 0 end),0),'sale_kg',coalesce(sum(case when o.note like '[SALE]%' then oi.quantity_kg else 0 end),0),'purchase_amount',coalesce(sum(case when o.role='ARRIVAL' then oi.total_amount else 0 end),0),'shipment_amount',coalesce(sum(case when o.role='SHIPMENT' and o.note not like '[SALE]%' and o.note not like '[TRANSFER_TO_ANGAR]%' then oi.total_amount else 0 end),0),'sale_amount',coalesce(sum(case when o.note like '[SALE]%' then oi.total_amount else 0 end),0)) x from public.products p left join public.inventory_balances i on i.product_id=p.id and i.workspace_id=v_ws left join public.operation_items oi on oi.product_id=p.id and oi.workspace_id=v_ws left join public.operations o on o.id=oi.operation_id and o.workspace_id=v_ws and o.operation_date between p_from and p_to and coalesce(o.note,'') not like '[STOCKTAKE]%' where p.workspace_id=v_ws and p.status='ACTIVE' group by p.id,p.name,p.category,p.sort_order,i.quantity_kg) q),'[]'::jsonb),
    'employees',coalesce((select jsonb_agg(x order by (x->>'total_amount')::numeric desc) from (
      select jsonb_build_object(
        'employee_id',pe.id,'employee_name',pe.name,
        'expense_amount',coalesce(sum(e.amount) filter (where not e.is_loan),0),
        'loan_amount',coalesce(sum(e.amount) filter (where e.is_loan),0),
        'total_amount',coalesce(sum(e.amount),0),
        'repaid_in_period',coalesce((select sum(r.amount) from public.point_loan_repayments r join public.point_evening_expenses e2 on e2.id=r.expense_id where e2.employee_id=pe.id and r.workspace_id=v_ws and r.repay_date between p_from and p_to),0),
        'debt_remaining',coalesce((select sum(e3.amount-coalesce(rp.paid,0)) from public.point_evening_expenses e3 left join (select expense_id,sum(amount) paid from public.point_loan_repayments group by expense_id) rp on rp.expense_id=e3.id where e3.employee_id=pe.id and e3.workspace_id=v_ws and e3.is_loan),0)
      ) x
      from public.point_employees pe
      left join public.point_evening_expenses e on e.employee_id=pe.id and e.workspace_id=v_ws
      left join public.point_evening_summaries s on s.id=e.summary_id and s.summary_date between p_from and p_to
      where pe.workspace_id=v_ws
      group by pe.id,pe.name
      having coalesce(sum(e.amount),0)<>0 or coalesce((select sum(e3.amount-coalesce(rp.paid,0)) from public.point_evening_expenses e3 left join (select expense_id,sum(amount) paid from public.point_loan_repayments group by expense_id) rp on rp.expense_id=e3.id where e3.employee_id=pe.id and e3.workspace_id=v_ws and e3.is_loan),0)<>0
    ) q),'[]'::jsonb),
    'categories',coalesce((select jsonb_agg(x order by (x->>'amount')::numeric desc) from (select jsonb_build_object('category',e.category,'amount',sum(e.amount),'count',count(*)) x from public.point_evening_expenses e join public.point_evening_summaries s on s.id=e.summary_id where e.workspace_id=v_ws and s.summary_date between p_from and p_to group by e.category) q),'[]'::jsonb),
    'days',coalesce((
      select jsonb_agg(jsonb_build_object(
        'date',d.dt,'status',s.status,
        'purchase_amount',coalesce(dv.purchase_amount,0),'purchase_kg',coalesce(dv.purchase_kg,0),'shipment_amount',coalesce(dv.shipment_amount,0),'sale_amount',coalesce(dv.sale_amount,0),
        'expense_amount',coalesce(ex.expense_amount,0),'loan_amount',coalesce(ex.loan_amount,0),
        'repayment_amount',coalesce((select sum(r.amount) from public.point_loan_repayments r where r.workspace_id=v_ws and r.repay_date=d.dt),0),
        'opening_cash',s.opening_cash,'brought_cash',s.brought_cash,'actual_cash',s.actual_cash,'expected_cash',s.expected_cash,'variance',s.variance,
        'ops',coalesce(dv.ops,0),'comment',s.close_comment
      ) order by d.dt desc)
      from generate_series(p_from,p_to,interval '1 day') as d(dt)
      left join public.point_evening_summaries s on s.workspace_id=v_ws and s.summary_date=d.dt::date
      left join lateral (
        select
          sum(case when o.role='ARRIVAL' then oi.total_amount else 0 end) as purchase_amount,
          sum(case when o.role='ARRIVAL' then oi.quantity_kg else 0 end) as purchase_kg,
          sum(case when o.role='SHIPMENT' and o.note not like '[SALE]%' and o.note not like '[TRANSFER_TO_ANGAR]%' then oi.total_amount else 0 end) as shipment_amount,
          sum(case when o.note like '[SALE]%' then oi.total_amount else 0 end) as sale_amount,
          count(distinct o.id) as ops
        from public.operations o join public.operation_items oi on oi.operation_id=o.id
        where o.workspace_id=v_ws and o.operation_date=d.dt::date and coalesce(o.note,'') not like '[STOCKTAKE]%' and coalesce(o.status,'CONFIRMED')<>'CANCELLED'
      ) dv on true
      left join lateral (
        select sum(e.amount) filter (where not e.is_loan) as expense_amount, sum(e.amount) filter (where e.is_loan) as loan_amount
        from public.point_evening_expenses e where e.summary_id=s.id
      ) ex on true
    ),'[]'::jsonb)
  ) into v_result
  from public.operations o join public.operation_items oi on oi.operation_id=o.id
  where o.workspace_id=v_ws and o.operation_date between p_from and p_to and coalesce(o.note,'') not like '[STOCKTAKE]%' and coalesce(o.status,'CONFIRMED')<>'CANCELLED';
  return coalesce(v_result,'{}'::jsonb);
end;
$function$;

revoke all on function public.point_get_report(date,date) from public, anon;
grant execute on function public.point_get_report(date,date) to authenticated, service_role;
