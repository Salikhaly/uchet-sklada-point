-- get_client_profit v2: + дата последней операции и последние приходы/продажи по каждому контрагенту
-- (чтобы видеть «от кого именно» и когда привозил/покупал последний раз). Остальное — как в v1.
create or replace function public.get_client_profit(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable set search_path to 'public','pg_catalog'
as $$
declare
  v_ws uuid := public.current_workspace_id();
  v_from date := coalesce(p_from, '1900-01-01'::date);
  v_to date := coalesce(p_to, current_date);
  v_result jsonb;
begin
  with base as (
    select o.id as op_id, o.operation_date as d, o.type, o.contractor_id, c.name as cname, c.group_id, g.name as gname,
           p.name as pname, oi.quantity_kg as kg, oi.total_amount as amt, coalesce(oi.cogs_amount,0) as cogs
    from public.operations o
    join public.operation_items oi on oi.operation_id = o.id and oi.workspace_id = v_ws
    join public.products p on p.id = oi.product_id and p.workspace_id = v_ws
    join public.contractors c on c.id = o.contractor_id and c.workspace_id = v_ws
    left join public.contractor_groups g on g.id = c.group_id and g.workspace_id = v_ws
    where o.workspace_id = v_ws and o.status = 'CONFIRMED' and o.role <> 'AUTO_REPLENISH'
      and o.operation_date between v_from and v_to
  ),
  mk as (
    select pname,
      sum(amt) filter (where type='ARRIVAL')  / nullif(sum(kg) filter (where type='ARRIVAL'),0)  as avg_buy,
      sum(amt) filter (where type='SHIPMENT') / nullif(sum(kg) filter (where type='SHIPMENT'),0) as avg_sale
    from base group by pname
  ),
  ops_cnt as (
    select contractor_id, type, count(distinct op_id) as ops, max(d) as last_d from base group by contractor_id, type
  ),
  op_tot as (
    select contractor_id, type, op_id, d, sum(kg) as kg, sum(amt) as amt from base group by contractor_id, type, op_id, d
  ),
  bm as (
    select b.contractor_id, b.cname, b.group_id, b.gname, b.pname, sum(b.kg) as kg, sum(b.amt) as revenue, sum(b.cogs) as cogs, m.avg_sale
    from base b join mk m using (pname) where b.type = 'SHIPMENT'
    group by b.contractor_id, b.cname, b.group_id, b.gname, b.pname, m.avg_sale
  ),
  sm as (
    select b.contractor_id, b.cname, b.group_id, b.gname, b.pname, sum(b.kg) as kg, sum(b.amt) as spent, m.avg_buy, m.avg_sale
    from base b join mk m using (pname) where b.type = 'ARRIVAL'
    group by b.contractor_id, b.cname, b.group_id, b.gname, b.pname, m.avg_buy, m.avg_sale
  ),
  buyers as (
    select bm.contractor_id, bm.cname, bm.group_id, bm.gname,
      sum(bm.revenue) as revenue, sum(bm.cogs) as cogs, sum(bm.kg) as kg,
      sum(bm.revenue - bm.avg_sale * bm.kg) as premium,
      coalesce(max(oc.ops),0) as ops, max(oc.last_d) as last_d,
      jsonb_agg(jsonb_build_object('product', bm.pname, 'kg', bm.kg, 'revenue', bm.revenue, 'cogs', bm.cogs, 'avg_sale', bm.avg_sale,
                                   'premium', bm.revenue - bm.avg_sale * bm.kg) order by bm.revenue desc) as metals
    from bm left join ops_cnt oc on oc.contractor_id = bm.contractor_id and oc.type = 'SHIPMENT'
    group by bm.contractor_id, bm.cname, bm.group_id, bm.gname
  ),
  suppliers as (
    select sm.contractor_id, sm.cname, sm.group_id, sm.gname,
      sum(sm.spent) as spent, sum(sm.kg) as kg,
      sum(sm.avg_buy * sm.kg - sm.spent) as saving,
      sum(case when sm.avg_sale is not null then sm.avg_sale * sm.kg - sm.spent end) as exp_profit,
      sum(case when sm.avg_sale is not null then sm.spent else 0 end) as assessed,
      coalesce(max(oc.ops),0) as ops, max(oc.last_d) as last_d,
      jsonb_agg(jsonb_build_object('product', sm.pname, 'kg', sm.kg, 'spent', sm.spent, 'avg_buy', sm.avg_buy, 'avg_sale', sm.avg_sale,
                                   'saving', sm.avg_buy * sm.kg - sm.spent,
                                   'exp_profit', case when sm.avg_sale is not null then sm.avg_sale * sm.kg - sm.spent end) order by sm.spent desc) as metals
    from sm left join ops_cnt oc on oc.contractor_id = sm.contractor_id and oc.type = 'ARRIVAL'
    group by sm.contractor_id, sm.cname, sm.group_id, sm.gname
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'in_sum',  coalesce((select sum(amt) from base where type='ARRIVAL'),0),
      'in_kg',   coalesce((select sum(kg)  from base where type='ARRIVAL'),0),
      'out_sum', coalesce((select sum(amt) from base where type='SHIPMENT'),0),
      'out_kg',  coalesce((select sum(kg)  from base where type='SHIPMENT'),0),
      'cogs',    coalesce((select sum(cogs) from base where type='SHIPMENT'),0)
    ),
    'buyers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.contractor_id, 'name', b.cname, 'group_id', b.group_id, 'group', b.gname, 'revenue', b.revenue, 'cogs', b.cogs,
        'profit', b.revenue - b.cogs, 'kg', b.kg, 'premium', b.premium, 'ops', b.ops, 'last_date', b.last_d,
        'recent', (select coalesce(jsonb_agg(jsonb_build_object('date', x.d, 'kg', x.kg, 'amount', x.amt) order by x.d desc), '[]'::jsonb)
                   from (select d, kg, amt from op_tot t where t.contractor_id = b.contractor_id and t.type = 'SHIPMENT' order by d desc, op_id limit 8) x),
        'metals', b.metals) order by b.revenue - b.cogs desc) from buyers b), '[]'::jsonb),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.contractor_id, 'name', s.cname, 'group_id', s.group_id, 'group', s.gname, 'spent', s.spent, 'kg', s.kg, 'saving', s.saving,
        'exp_profit', s.exp_profit, 'assessed', s.assessed, 'ops', s.ops, 'last_date', s.last_d,
        'recent', (select coalesce(jsonb_agg(jsonb_build_object('date', x.d, 'kg', x.kg, 'amount', x.amt) order by x.d desc), '[]'::jsonb)
                   from (select d, kg, amt from op_tot t where t.contractor_id = s.contractor_id and t.type = 'ARRIVAL' order by d desc, op_id limit 8) x),
        'metals', s.metals) order by s.spent desc) from suppliers s), '[]'::jsonb)
  ) into v_result;
  return v_result;
end $$;

revoke all on function public.get_client_profit(date,date) from public, anon;
grant execute on function public.get_client_profit(date,date) to authenticated, service_role;
