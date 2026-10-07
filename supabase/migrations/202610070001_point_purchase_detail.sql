-- Закуп в разрезе «металл × день» для экрана «Закуп и цена по металлам» в отчёте Точки.
-- Правила те же, что у итогов отчёта: только приходы (ARRIVAL), без отменённых операций и инвентаризаций.
create or replace function public.point_get_purchase_detail(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path to 'public','pg_catalog'
as $$
declare v_ws uuid := public.current_point_workspace_id();
begin
  perform public.ensure_point_member();
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Неверный период'; end if;
  if p_to - p_from > 400 then raise exception 'Период слишком большой'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'date', q.d, 'product', q.name, 'category', q.category, 'sort_order', q.sort_order, 'kg', q.kg, 'amount', q.amount
    ) order by q.d, q.sort_order nulls last, q.name)
    from (
      select o.operation_date as d, p.name, p.category, p.sort_order,
             sum(oi.quantity_kg) as kg, sum(oi.total_amount) as amount
      from public.operations o
      join public.operation_items oi on oi.operation_id = o.id
      join public.products p on p.id = oi.product_id
      where o.workspace_id = v_ws and o.role = 'ARRIVAL'
        and o.operation_date between p_from and p_to
        and coalesce(o.note,'') not like '[STOCKTAKE]%'
        and coalesce(o.status,'CONFIRMED') <> 'CANCELLED'
      group by o.operation_date, p.id, p.name, p.category, p.sort_order
    ) q
  ), '[]'::jsonb);
end $$;

revoke all on function public.point_get_purchase_detail(date,date) from public, anon;
grant execute on function public.point_get_purchase_detail(date,date) to authenticated, service_role;
