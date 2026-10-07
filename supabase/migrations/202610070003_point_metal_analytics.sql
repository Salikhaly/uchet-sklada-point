-- Аналитика металла для владельца: по каждому металлу за период — закуп, отгрузка, продажа,
-- себестоимость, перемещение в Ангар и остаток в деньгах (inventory_balances, на сегодня).
-- Классификация как в point_get_report: [SALE] — продажа, [TRANSFER_TO_ANGAR] — перемещение (не выручка),
-- остальное SHIPMENT — отгрузка. Отменённые операции и инвентаризации не считаются.
create or replace function public.point_get_metal_analytics(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path to 'public','pg_catalog'
as $$
declare v_ws uuid := public.current_point_workspace_id();
begin
  perform public.ensure_point_member();
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Неверный период'; end if;
  if p_to - p_from > 400 then raise exception 'Период слишком большой'; end if;
  return coalesce((
    select jsonb_agg(q.x order by coalesce((q.x->>'sort_order')::int, 999999), q.x->>'product')
    from (
      select jsonb_build_object(
        'product', t.name, 'category', t.category, 'sort_order', t.sort_order,
        'buy_kg', t.buy_kg, 'buy_amount', t.buy_amount,
        'ship_kg', t.ship_kg, 'ship_amount', t.ship_amount, 'ship_cogs', t.ship_cogs,
        'sale_kg', t.sale_kg, 'sale_amount', t.sale_amount, 'sale_cogs', t.sale_cogs,
        'transfer_kg', t.transfer_kg, 'transfer_cogs', t.transfer_cogs,
        'stock_kg', t.stock_kg, 'stock_cost', t.stock_cost, 'avg_cost', t.avg_cost
      ) as x
      from (
        select p.name::text as name, p.category, p.sort_order,
          coalesce(sum(m.quantity_kg)  filter (where m.role='ARRIVAL'),0) as buy_kg,
          coalesce(sum(m.total_amount) filter (where m.role='ARRIVAL'),0) as buy_amount,
          coalesce(sum(m.quantity_kg)  filter (where m.kind='ship'),0) as ship_kg,
          coalesce(sum(m.total_amount) filter (where m.kind='ship'),0) as ship_amount,
          coalesce(sum(m.cogs_amount)  filter (where m.kind='ship'),0) as ship_cogs,
          coalesce(sum(m.quantity_kg)  filter (where m.kind='sale'),0) as sale_kg,
          coalesce(sum(m.total_amount) filter (where m.kind='sale'),0) as sale_amount,
          coalesce(sum(m.cogs_amount)  filter (where m.kind='sale'),0) as sale_cogs,
          coalesce(sum(m.quantity_kg)  filter (where m.kind='transfer'),0) as transfer_kg,
          coalesce(sum(m.cogs_amount)  filter (where m.kind='transfer'),0) as transfer_cogs,
          coalesce(max(ib.quantity_kg),0) as stock_kg, coalesce(max(ib.cost_amount),0) as stock_cost, coalesce(max(ib.avg_cost),0) as avg_cost
        from public.products p
        left join public.inventory_balances ib on ib.product_id = p.id and ib.workspace_id = v_ws
        left join (
          select oi.product_id, o.role, oi.quantity_kg, oi.total_amount, oi.cogs_amount,
                 case when o.role = 'SHIPMENT' and coalesce(o.note,'') like '[SALE]%' then 'sale'
                      when o.role = 'SHIPMENT' and coalesce(o.note,'') like '[TRANSFER_TO_ANGAR]%' then 'transfer'
                      when o.role = 'SHIPMENT' then 'ship' end as kind
          from public.operations o
          join public.operation_items oi on oi.operation_id = o.id
          where o.workspace_id = v_ws and o.operation_date between p_from and p_to
            and coalesce(o.note,'') not like '[STOCKTAKE]%' and coalesce(o.status,'CONFIRMED') <> 'CANCELLED'
        ) m on m.product_id = p.id
        where p.workspace_id = v_ws and p.status = 'ACTIVE'
        group by p.id, p.name, p.category, p.sort_order
      ) t
      where t.buy_kg > 0 or t.ship_kg > 0 or t.sale_kg > 0 or t.transfer_kg > 0 or t.stock_kg > 0
    ) q
  ), '[]'::jsonb);
end $$;

revoke all on function public.point_get_metal_analytics(date,date) from public, anon;
grant execute on function public.point_get_metal_analytics(date,date) to authenticated, service_role;
