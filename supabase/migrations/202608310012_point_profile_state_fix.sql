begin;

-- Keep signup compatible with the existing deployment model:
-- the login server binds the user to SUPABASE_WORKSPACE_ID and creates/syncs Point.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_workspace uuid;
  v_name text;
begin
  v_name:=coalesce(nullif(new.raw_user_meta_data->>'display_name',''),new.email);
  insert into public.workspaces(name)
    values(coalesce(nullif(new.raw_user_meta_data->>'workspace_name',''),'Мой склад'))
    returning id into v_workspace;
  insert into public.profiles(id,workspace_id,point_workspace_id,role,display_name)
    values(new.id,v_workspace,null,'admin',v_name)
    on conflict(id) do nothing;
  return new;
end; $$;

-- A receipt can legitimately have no contractor; do not hide it from the Point journal.
create or replace function public.point_get_state()
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_ws uuid:=public.current_point_workspace_id();
  v_result jsonb;
begin
  perform public.ensure_point_member();
  select jsonb_build_object(
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'default_price',p.default_price,'status',p.status,'sort_order',coalesce(p.sort_order,0)) order by coalesce(p.sort_order,0),p.name) from products p where p.workspace_id=v_ws and p.status='ACTIVE'),'[]'::jsonb),
    'contractors',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'group_id',c.group_id,'group_name',g.name) order by c.name) from contractors c left join contractor_groups g on g.id=c.group_id where c.workspace_id=v_ws and c.archived_at is null),'[]'::jsonb),
    'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.name) order by g.name) from contractor_groups g where g.workspace_id=v_ws and g.archived_at is null),'[]'::jsonb),
    'employees',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'name',e.name) order by e.name) from point_employees e where e.workspace_id=v_ws and e.active),'[]'::jsonb),
    'stock',coalesce((select jsonb_agg(jsonb_build_object('product_id',p.id,'product_name',p.name,'quantity_kg',coalesce(i.quantity_kg,0),'avg_cost',coalesce(i.avg_cost,0),'inventory_value',coalesce(i.cost_amount,0)) order by p.name) from products p left join inventory_balances i on i.product_id=p.id and i.workspace_id=v_ws where p.workspace_id=v_ws and p.status='ACTIVE'),'[]'::jsonb),
    'operations',coalesce((select jsonb_agg(x order by (x->>'operation_date') desc,(x->>'created_at') desc) from (
      select jsonb_build_object('id',o.id,'operation_number',o.operation_number,'operation_date',o.operation_date,'type',o.type,'role',o.role,'status',coalesce(o.status,'CONFIRMED'),'contractor_id',o.contractor_id,'contractor_name',c.name,'group_name',g.name,'created_at',o.created_at,'note',o.note,
      'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',i.product_id,'product_name',p.name,'kg',i.quantity_kg,'price',i.unit_price,'sum',i.total_amount,'wasteKg',i.waste_kg,'cogs',i.cogs_amount) order by p.name) from operation_items i join products p on p.id=i.product_id where i.operation_id=o.id),'[]'::jsonb)) x
      from operations o left join contractors c on c.id=o.contractor_id left join contractor_groups g on g.id=c.group_id where o.workspace_id=v_ws and coalesce(o.status,'CONFIRMED')<>'CANCELLED' limit 500) q),'[]'::jsonb)
  ) into v_result;
  return v_result;
end; $$;

grant execute on function public.point_get_state() to authenticated;
commit;
