alter table public.products add column if not exists sort_order integer not null default 0;
update public.products p
set sort_order = x.rn
from (
  select id, row_number() over (partition by workspace_id order by sort_order asc, name asc) - 1 as rn
  from public.products
) x
where x.id = p.id;
create index if not exists products_workspace_sort_idx on public.products(workspace_id, sort_order, name);

create or replace function public.reorder_products(p_product_ids uuid[])
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_workspace uuid:=public.current_workspace_id();
  v_id uuid;
  v_pos integer:=0;
begin
  if v_workspace is null then raise exception 'Склад не найден'; end if;
  perform public.ensure_manager();
  if p_product_ids is null then raise exception 'Не передан порядок товаров'; end if;
  if (select count(*) from unnest(p_product_ids)) <> (select count(distinct x) from unnest(p_product_ids) x) then raise exception 'В списке товаров есть дубли'; end if;
  if exists(select 1 from public.products p where p.workspace_id=v_workspace and p.status='ACTIVE' and not (p.id = any(p_product_ids))) then
    raise exception 'В списке отсутствуют активные товары';
  end if;
  foreach v_id in array p_product_ids loop
    update public.products set sort_order=v_pos,updated_at=now() where id=v_id and workspace_id=v_workspace and status='ACTIVE';
    v_pos:=v_pos+1;
  end loop;
end; $$;

create or replace function public.dashboard_summary()
returns table(product_id uuid,product_name text,quantity_kg numeric,avg_cost numeric,inventory_value numeric)
language sql stable security invoker set search_path=public,pg_catalog as $$
select p.id,p.name,coalesce(i.quantity_kg,0),coalesce(i.avg_cost,0),coalesce(i.cost_amount,0)
from public.products p
left join public.inventory_balances i on i.product_id=p.id and i.workspace_id=public.current_workspace_id()
where p.workspace_id=public.current_workspace_id() and p.status='ACTIVE'
order by p.sort_order,p.name
$$;

create or replace function public.upsert_product(p_name text,p_price numeric,p_status public.product_status default 'ACTIVE')
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_id uuid; v_old numeric; v_sort integer;
begin
  perform public.ensure_manager();
  select id,default_price into v_id,v_old from products where workspace_id=v_ws and lower(name)=lower(trim(p_name)) for update;
  if v_id is null then
    select coalesce(max(sort_order),-1)+1 into v_sort from products where workspace_id=v_ws;
    insert into products(workspace_id,name,default_price,status,sort_order) values(v_ws,trim(p_name),p_price,p_status,v_sort) returning id into v_id;
    insert into price_history(workspace_id,product_id,old_price,new_price,source,changed_by) values(v_ws,v_id,0,p_price,'NEW',auth.uid());
  else
    update products set default_price=p_price,status=p_status where id=v_id;
    if v_old is distinct from p_price then insert into price_history(workspace_id,product_id,old_price,new_price,source,changed_by) values(v_ws,v_id,v_old,p_price,'MANUAL',auth.uid()); end if;
  end if;
  return v_id;
end; $$;

create or replace function public.delete_operation(p_operation_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_workspace uuid:=public.current_workspace_id(); v_old public.operations%rowtype; v_products uuid[]; v_product uuid; v_old_data jsonb;
begin
  perform public.ensure_manager();
  select * into v_old from public.operations where id=p_operation_id and workspace_id=v_workspace for update;
  if not found then raise exception 'Операция не найдена'; end if;
  if v_old.role='AUTO_REPLENISH' then raise exception 'Исторический автоприход доступен только для просмотра'; end if;
  if exists(select 1 from public.operations where parent_operation_id=p_operation_id and role='AUTO_REPLENISH') then raise exception 'Отгрузка связана со старым автоприходом и заблокирована для удаления'; end if;
  select array_agg(distinct product_id) into v_products from public.operation_items where operation_id=p_operation_id;
  v_old_data:=jsonb_build_object('type',v_old.type,'role',v_old.role,'status',v_old.status,'date',v_old.operation_date,'contractor_id',v_old.contractor_id,'items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',oi.product_id,'kg',oi.quantity_kg,'price',oi.unit_price,'wasteKg',oi.waste_kg) order by oi.product_id),'[]'::jsonb) from public.operation_items oi where oi.operation_id=p_operation_id));
  if v_old.type='SHIPMENT' then for v_product in select unnest(coalesce(v_products,'{}'::uuid[])) order by 1 loop perform public.lock_product(v_workspace,v_product); end loop; end if;
  insert into public.audit_log(workspace_id,action,operation_id,user_id,old_data,details) values(v_workspace,'ПОЛНОЕ УДАЛЕНИЕ ОПЕРАЦИИ',p_operation_id,auth.uid(),v_old_data,'Физическое удаление по подтверждению пользователя');
  delete from public.operations where id=p_operation_id and workspace_id=v_workspace;
  for v_product in select unnest(coalesce(v_products,'{}'::uuid[])) order by 1 loop perform public.rebuild_product_valuation(v_product,v_workspace); end loop;
end; $$;
