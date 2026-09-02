create or replace function public.get_profit_report(p_from date default null,p_to date default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path=public,pg_catalog
as $$
declare
  v_workspace uuid := public.current_workspace_id();
  v_from date := coalesce(p_from, '1900-01-01'::date);
  v_to date := coalesce(p_to, current_date);
  v_result jsonb;
begin
  with base as (
    select
      o.id,
      o.operation_date,
      o.type,
      o.role,
      o.status,
      o.contractor_id,
      c.name as contractor_name,
      c.group_id,
      g.name as group_name,
      oi.product_id,
      p.name as product_name,
      oi.quantity_kg,
      oi.total_amount,
      coalesce(oi.cogs_amount,0) as cogs_amount
    from public.operations o
    join public.operation_items oi on oi.operation_id=o.id and oi.workspace_id=v_workspace
    join public.products p on p.id=oi.product_id and p.workspace_id=v_workspace
    join public.contractors c on c.id=o.contractor_id and c.workspace_id=v_workspace
    left join public.contractor_groups g on g.id=c.group_id and g.workspace_id=v_workspace
    where o.workspace_id=v_workspace
      and o.status='CONFIRMED'
      and o.operation_date between v_from and v_to
  ),
  totals as (
    select
      coalesce(sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' then total_amount else 0 end),0) as in_sum,
      coalesce(sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' then quantity_kg else 0 end),0) as in_kg,
      count(distinct case when type='ARRIVAL' and role<>'AUTO_REPLENISH' then id end) as in_count,
      coalesce(sum(case when type='SHIPMENT' then total_amount else 0 end),0) as out_sum,
      coalesce(sum(case when type='SHIPMENT' then quantity_kg else 0 end),0) as out_kg,
      count(distinct case when type='SHIPMENT' then id end) as out_count,
      coalesce(sum(case when type='SHIPMENT' then cogs_amount else 0 end),0) as cogs,
      coalesce(sum(case when type='SHIPMENT' then total_amount-cogs_amount else 0 end),0) as profit
    from base
  ),
  product_rows as (
    select
      product_id,
      product_name as name,
      sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' then quantity_kg else 0 end) as in_kg,
      sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' then total_amount else 0 end) as in_sum,
      sum(case when type='SHIPMENT' then quantity_kg else 0 end) as out_kg,
      sum(case when type='SHIPMENT' then total_amount else 0 end) as out_sum,
      sum(case when type='SHIPMENT' then cogs_amount else 0 end) as cogs
    from base
    group by product_id, product_name
  ),
  client_rows as (
    select
      contractor_id,
      contractor_name as name,
      group_id,
      group_name,
      sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' then total_amount else 0 end) as in_sum,
      sum(case when type='SHIPMENT' then total_amount else 0 end) as out_sum,
      sum(case when type='SHIPMENT' then cogs_amount else 0 end) as cogs
    from base
    where role<>'AUTO_REPLENISH'
    group by contractor_id, contractor_name, group_id, group_name
  ),
  group_rows as (
    select
      group_id,
      group_name as name,
      sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' then total_amount else 0 end) as in_sum,
      sum(case when type='SHIPMENT' then total_amount else 0 end) as out_sum,
      sum(case when type='SHIPMENT' then cogs_amount else 0 end) as cogs
    from base
    where role<>'AUTO_REPLENISH' and group_id is not null
    group by group_id, group_name
  ),
  daily_rows as (
    select
      operation_date as date,
      sum(case when type='ARRIVAL' and role<>'AUTO_REPLENISH' then total_amount else 0 end) as in_sum,
      sum(case when type='SHIPMENT' then total_amount else 0 end) as out_sum
    from base
    group by operation_date
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
      'in_sum',in_sum,'in_kg',in_kg,'in_count',in_count,
      'out_sum',out_sum,'out_kg',out_kg,'out_count',out_count,
      'cogs',cogs,'profit',profit,
      'margin',case when out_sum<>0 then (profit/out_sum)*100 else 0 end
    ) from totals),
    'products', coalesce((select jsonb_agg(
      jsonb_build_object(
        'name',name,'in_kg',in_kg,'in_sum',in_sum,'out_kg',out_kg,'out_sum',out_sum,
        'cogs',cogs,'profit',out_sum-cogs,
        'margin',case when out_sum<>0 then ((out_sum-cogs)/out_sum)*100 else 0 end
      ) order by out_sum desc, name
    ) from product_rows),'[]'::jsonb),
    'clients', coalesce((select jsonb_agg(
      jsonb_build_object(
        'name',name,'group',group_name,'parent',group_name,'isGroup',false,
        'in_sum',in_sum,'out_sum',out_sum,'cogs',cogs,'profit',out_sum-cogs,
        'margin',case when out_sum<>0 then ((out_sum-cogs)/out_sum)*100 else 0 end
      ) order by out_sum desc, name
    ) from client_rows),'[]'::jsonb),
    'groups', coalesce((select jsonb_agg(
      jsonb_build_object(
        'name',name,'isGroup',true,
        'in_sum',in_sum,'out_sum',out_sum,'cogs',cogs,'profit',out_sum-cogs,
        'margin',case when out_sum<>0 then ((out_sum-cogs)/out_sum)*100 else 0 end
      ) order by out_sum desc, name
    ) from group_rows),'[]'::jsonb),
    'daily', coalesce((select jsonb_agg(
      jsonb_build_object('date',to_char(date,'YYYY-MM-DD'),'in_sum',in_sum,'out_sum',out_sum)
      order by date
    ) from daily_rows),'[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_profit_report(date,date) from public;
grant execute on function public.get_profit_report(date,date) to authenticated;
