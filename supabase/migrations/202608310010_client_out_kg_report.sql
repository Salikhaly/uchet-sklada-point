-- Report extension for the receiving point: show how much each counterparty actually took.
create or replace function public.get_profit_report(
  p_from date default null,
  p_to date default null
)
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
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'in_sum', coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.total_amount else 0 end),0),
      'in_kg', coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.quantity_kg else 0 end),0),
      'in_count', count(distinct case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then o.id end),
      'out_sum', coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount else 0 end),0),
      'out_kg', coalesce(sum(case when o.type='SHIPMENT' then oi.quantity_kg else 0 end),0),
      'out_count', count(distinct case when o.type='SHIPMENT' then o.id end),
      'cogs', coalesce(sum(case when o.type='SHIPMENT' then oi.cogs_amount else 0 end),0),
      'profit', coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount-oi.cogs_amount else 0 end),0)
    ),
    'products', coalesce((
      select jsonb_agg(x order by (x->>'out_sum')::numeric desc) from (
        select jsonb_build_object(
          'name',p.name,
          'in_kg',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.quantity_kg else 0 end),0),
          'in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.total_amount else 0 end),0),
          'out_kg',coalesce(sum(case when o.type='SHIPMENT' then oi.quantity_kg else 0 end),0),
          'out_sum',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount else 0 end),0),
          'cogs',coalesce(sum(case when o.type='SHIPMENT' then oi.cogs_amount else 0 end),0),
          'profit',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount-oi.cogs_amount else 0 end),0)
        ) x
        from operation_items oi
        join operations o on o.id=oi.operation_id
        join products p on p.id=oi.product_id
        where oi.workspace_id=v_workspace and o.workspace_id=v_workspace
          and o.operation_date between v_from and v_to and o.status='CONFIRMED'
        group by p.id,p.name
      ) q
    ),'[]'::jsonb),
    'clients', coalesce((
      select jsonb_agg(x order by (x->>'out_sum')::numeric desc) from (
        select jsonb_build_object(
          'name',c.name, 'group',g.name,
          'in_kg',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.quantity_kg else 0 end),0),
          'in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.total_amount else 0 end),0),
          'out_kg',coalesce(sum(case when o.type='SHIPMENT' then oi.quantity_kg else 0 end),0),
          'out_sum',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount else 0 end),0),
          'cogs',coalesce(sum(case when o.type='SHIPMENT' then oi.cogs_amount else 0 end),0),
          'profit',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount-oi.cogs_amount else 0 end),0)
        ) x
        from operations o
        join operation_items oi on oi.operation_id=o.id
        join contractors c on c.id=o.contractor_id
        left join contractor_groups g on g.id=c.group_id
        where o.workspace_id=v_workspace and oi.workspace_id=v_workspace
          and o.operation_date between v_from and v_to and o.status='CONFIRMED'
          and o.role<>'AUTO_REPLENISH'
        group by c.id,c.name,g.name
      ) q
    ),'[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(x order by (x->>'out_sum')::numeric desc) from (
        select jsonb_build_object(
          'name',g.name,
          'in_kg',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.quantity_kg else 0 end),0),
          'in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.total_amount else 0 end),0),
          'out_kg',coalesce(sum(case when o.type='SHIPMENT' then oi.quantity_kg else 0 end),0),
          'out_sum',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount else 0 end),0),
          'cogs',coalesce(sum(case when o.type='SHIPMENT' then oi.cogs_amount else 0 end),0),
          'profit',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount-oi.cogs_amount else 0 end),0)
        ) x
        from operations o
        join operation_items oi on oi.operation_id=o.id
        join contractors c on c.id=o.contractor_id
        join contractor_groups g on g.id=c.group_id
        where o.workspace_id=v_workspace and oi.workspace_id=v_workspace
          and o.operation_date between v_from and v_to and o.status='CONFIRMED'
          and o.role<>'AUTO_REPLENISH'
        group by g.id,g.name
      ) q
    ),'[]'::jsonb)
  ) into v_result
  from operation_items oi
  join operations o on o.id=oi.operation_id
  where oi.workspace_id=v_workspace and o.workspace_id=v_workspace
    and o.operation_date between v_from and v_to and o.status='CONFIRMED';
  return v_result;
end;
$$;
