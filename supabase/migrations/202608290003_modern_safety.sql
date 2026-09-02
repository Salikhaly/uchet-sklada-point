begin;

-- Production-safe extension for the V2 UI: status, versioning, idempotency,
-- cancellation, richer audit, and control checks.

alter table public.operations
  add column if not exists status text not null default 'CONFIRMED',
  add column if not exists version integer not null default 1,
  add column if not exists idempotency_key uuid;

alter table public.operations
  drop constraint if exists operations_status_check;
alter table public.operations
  add constraint operations_status_check check (status in ('DRAFT','CONFIRMED','CANCELLED'));

create unique index if not exists operations_workspace_idempotency_uq
  on public.operations(workspace_id,idempotency_key)
  where idempotency_key is not null;
create index if not exists operations_workspace_status_idx
  on public.operations(workspace_id,status,operation_date desc,created_at desc);

-- Ignore cancelled operations when rebuilding stock/COGS.
create or replace function public.rebuild_product_valuation(p_product_id uuid,p_workspace_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  r record;
  v_qty numeric(16,3):=0;
  v_cost numeric(18,2):=0;
  v_avg numeric(18,8):=0;
  v_cogs numeric(18,2):=0;
begin
  perform public.ensure_member(p_workspace_id);
  perform public.lock_product(p_workspace_id,p_product_id);
  for r in
    select o.id operation_id,o.type,o.role,o.status,o.operation_date,o.created_at,i.id item_id,i.quantity_kg,i.unit_price
    from public.operations o
    join public.operation_items i on i.operation_id=o.id
    where o.workspace_id=p_workspace_id
      and i.workspace_id=p_workspace_id
      and i.product_id=p_product_id
      and o.status<>'CANCELLED'
    order by o.operation_date,o.created_at,o.id
  loop
    if r.role='AUTO_REPLENISH' or r.type='ARRIVAL' then
      v_qty:=v_qty+r.quantity_kg;
      v_cost:=v_cost+round(r.quantity_kg*r.unit_price,2);
      v_cogs:=0;
    else
      if v_qty+0.000001 < r.quantity_kg then
        raise exception 'Недостаточный остаток товара % на операции %: доступно %, требуется %',p_product_id,r.operation_id,round(v_qty,3),round(r.quantity_kg,3);
      end if;
      if v_qty>0 then v_avg:=v_cost/v_qty; else v_avg:=0; end if;
      v_cogs:=round(r.quantity_kg*v_avg,2);
      v_qty:=v_qty-r.quantity_kg;
      v_cost:=greatest(0,v_cost-v_cogs);
    end if;
    update public.operation_items
      set cogs_amount=case when r.role='SHIPMENT' then v_cogs else 0 end
      where id=r.item_id;
  end loop;
  insert into public.inventory_balances(workspace_id,product_id,quantity_kg,cost_amount,updated_at)
  values(p_workspace_id,p_product_id,greatest(0,v_qty),greatest(0,v_cost),now())
  on conflict(workspace_id,product_id)
  do update set quantity_kg=excluded.quantity_kg,cost_amount=excluded.cost_amount,updated_at=now();
end; $$;

-- Recreate post_operation with idempotency protection.
create or replace function public.post_operation(
  p_type public.operation_type,
  p_contractor_id uuid,
  p_operation_date date,
  p_items jsonb,
  p_note text default null,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_workspace uuid:=public.current_workspace_id();
  v_id uuid;
  v_existing uuid;
  v_num bigint;
  v_item_row record;
  v_product uuid;
  v_products uuid[];
  v_seen uuid[]:='{}';
  v_name text;
  v_qty numeric;
  v_price numeric;
  v_waste numeric;
  v_role public.operation_role;
begin
  if v_workspace is null then raise exception 'Пользователь не авторизован'; end if;
  if p_operation_date>current_date then raise exception 'Дата операции не может быть в будущем'; end if;
  if not exists(select 1 from public.contractors where id=p_contractor_id and workspace_id=v_workspace) then raise exception 'Контрагент не найден'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Нет товаров для операции'; end if;

  if p_idempotency_key is not null then
    select id into v_existing from public.operations where workspace_id=v_workspace and idempotency_key=p_idempotency_key;
    if v_existing is not null then return v_existing; end if;
  end if;

  v_role:=case when p_type='ARRIVAL' then 'ARRIVAL' else 'SHIPMENT' end;
  v_num:=public.next_operation_number(v_workspace,p_operation_date);
  insert into public.operations(workspace_id,operation_number,operation_date,type,role,status,version,idempotency_key,contractor_id,created_by,note)
  values(v_workspace,v_num,p_operation_date,p_type,v_role,'CONFIRMED',1,p_idempotency_key,p_contractor_id,auth.uid(),p_note)
  returning id into v_id;

  for v_item_row in select value from jsonb_array_elements(p_items) as t(value) loop
    v_name:=trim(v_item_row.value->>'name');
    v_product:=nullif(v_item_row.value->>'product_id','')::uuid;
    v_qty:=(v_item_row.value->>'kg')::numeric;
    v_price:=(v_item_row.value->>'price')::numeric;
    v_waste:=coalesce((v_item_row.value->>'wasteKg')::numeric,0);
    if v_product is null then
      select id into v_product from public.products where workspace_id=v_workspace and lower(name)=lower(v_name) and status='ACTIVE';
    end if;
    if v_product is null then raise exception 'Товар не найден: %',coalesce(v_name,''); end if;
    if v_qty is null or v_qty<=0 then raise exception 'Количество должно быть больше 0'; end if;
    if v_price is null or v_price<0 then raise exception 'Цена не может быть отрицательной'; end if;
    if v_waste<0 or v_waste>v_qty then raise exception 'Отход не может быть больше количества'; end if;
    if v_product=any(v_seen) then raise exception 'Товар указан в операции более одного раза: %',coalesce(v_name,v_product::text); end if;
    v_seen:=array_append(v_seen,v_product);
    perform public.lock_product(v_workspace,v_product);
    insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg)
    values(v_workspace,v_id,v_product,v_qty,v_price,v_waste);
  end loop;

  select array_agg(distinct product_id order by product_id) into v_products
    from public.operation_items where operation_id=v_id;
  if v_products is not null then
    foreach v_product in array v_products loop
      perform public.rebuild_product_valuation(v_product,v_workspace);
    end loop;
  end if;

  if p_type='SHIPMENT' and exists(select 1 from public.operation_items where operation_id=v_id and cogs_amount is null) then
    raise exception 'Не удалось рассчитать себестоимость';
  end if;

  insert into public.audit_log(workspace_id,action,operation_id,user_id,new_data,details)
  values(v_workspace,case when p_type='ARRIVAL' then 'СОЗДАНИЕ ПРИХОДА' else 'СОЗДАНИЕ ОТГРУЗКИ' end,v_id,auth.uid(),
    jsonb_build_object('type',p_type,'date',p_operation_date,'contractor_id',p_contractor_id,'items',p_items,'status','CONFIRMED','version',1),
    'Создание операции');
  return v_id;
end; $$;

-- Cancellation instead of destructive delete for new UI.
create or replace function public.cancel_operation(p_operation_id uuid,p_reason text default null)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_workspace uuid:=public.current_workspace_id();
  v_old public.operations%rowtype;
  v_products uuid[];
  v_product uuid;
begin
  perform public.ensure_manager();
  select * into v_old from public.operations where id=p_operation_id and workspace_id=v_workspace for update;
  if not found then raise exception 'Операция не найдена'; end if;
  if v_old.role='AUTO_REPLENISH' then raise exception 'Исторический автоприход доступен только для просмотра'; end if;
  if v_old.status='CANCELLED' then return; end if;
  if v_old.status<>'CONFIRMED' then raise exception 'Можно отменить только подтверждённую операцию'; end if;

  select array_agg(distinct product_id) into v_products from public.operation_items where operation_id=v_old.id;
  update public.operations set status='CANCELLED',version=version+1,updated_at=now() where id=v_old.id;
  insert into public.audit_log(workspace_id,action,operation_id,user_id,old_data,new_data,details)
  values(v_workspace,'ОТМЕНА ОПЕРАЦИИ',v_old.id,auth.uid(),
    jsonb_build_object('status',v_old.status,'version',v_old.version,'type',v_old.type,'date',v_old.operation_date,'contractor_id',v_old.contractor_id),
    jsonb_build_object('status','CANCELLED','version',v_old.version+1,'reason',coalesce(p_reason,'')),
    'Операция отменена вместо физического удаления');

  if v_products is not null then
    foreach v_product in array v_products loop
      perform public.rebuild_product_valuation(v_product,v_workspace);
    end loop;
  end if;
end; $$;

create or replace function public.restore_operation(p_operation_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_workspace uuid:=public.current_workspace_id();
  v_old public.operations%rowtype;
  v_products uuid[];
  v_product uuid;
begin
  perform public.ensure_manager();
  select * into v_old from public.operations where id=p_operation_id and workspace_id=v_workspace for update;
  if not found then raise exception 'Операция не найдена'; end if;
  if v_old.role='AUTO_REPLENISH' then raise exception 'Исторический автоприход доступен только для просмотра'; end if;
  if v_old.status<>'CANCELLED' then return; end if;
  select array_agg(distinct product_id) into v_products from public.operation_items where operation_id=v_old.id;
  update public.operations set status='CONFIRMED',version=version+1,updated_at=now() where id=v_old.id;
  if v_products is not null then
    foreach v_product in array v_products loop perform public.rebuild_product_valuation(v_product,v_workspace); end loop;
  end if;
  insert into public.audit_log(workspace_id,action,operation_id,user_id,old_data,new_data,details)
  values(v_workspace,'ВОССТАНОВЛЕНИЕ ОПЕРАЦИИ',v_old.id,auth.uid(),jsonb_build_object('status','CANCELLED','version',v_old.version),jsonb_build_object('status','CONFIRMED','version',v_old.version+1),'Операция восстановлена');
end; $$;

-- Full control report for one workspace.
create or replace function public.system_control_check()
returns jsonb language plpgsql stable security invoker set search_path=public,pg_catalog as $$
declare
  v_ws uuid:=public.current_workspace_id();
  v_errors jsonb:='[]'::jsonb;
  v_warnings jsonb:='[]'::jsonb;
  v_dup bigint;
  v_missing bigint;
  v_negative bigint;
  v_cancelled numeric;
begin
  select count(*) into v_dup from (select operation_date,operation_number,count(*) c from operations where workspace_id=v_ws group by 1,2 having count(*)>1) q;
  if v_dup>0 then v_errors:=v_errors||jsonb_build_array('Дубли номера операций: '||v_dup); end if;
  select count(*) into v_missing from operation_items oi left join products p on p.id=oi.product_id and p.workspace_id=v_ws where oi.workspace_id=v_ws and p.id is null;
  if v_missing>0 then v_errors:=v_errors||jsonb_build_array('Строки операций с отсутствующим товаром: '||v_missing); end if;
  select count(*) into v_negative from inventory_balances where workspace_id=v_ws and (quantity_kg<0 or cost_amount<0);
  if v_negative>0 then v_errors:=v_errors||jsonb_build_array('Отрицательные остатки/стоимость: '||v_negative); end if;
  select count(*) into v_cancelled from operations where workspace_id=v_ws and status='CANCELLED';
  if v_cancelled>0 then v_warnings:=v_warnings||jsonb_build_array('Отменённых операций: '||v_cancelled); end if;
  return jsonb_build_object('ok',jsonb_array_length(v_errors)=0,'errors',v_errors,'warnings',v_warnings,'checked_at',now());
end; $$;

revoke execute on function public.cancel_operation(uuid,text) from public;
revoke execute on function public.restore_operation(uuid) from public;
revoke execute on function public.system_control_check() from public;
grant execute on function public.cancel_operation(uuid,text) to authenticated;
grant execute on function public.restore_operation(uuid) to authenticated;
grant execute on function public.system_control_check() to authenticated;


-- Harden update_operation: only confirmed operations are editable; version increments; audit stores exact before/after.
create or replace function public.update_operation(p_operation_id uuid,p_contractor_id uuid,p_operation_date date,p_items jsonb,p_note text default null)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_workspace uuid:=public.current_workspace_id();
  v_old public.operations%rowtype;
  v_old_products uuid[];
  v_new_products uuid[];
  v_all_products uuid[];
  v_product uuid;
  v_item_row record;
  v_product_id uuid;
  v_name text;
  v_qty numeric;
  v_price numeric;
  v_waste numeric;
  v_seen uuid[]:='{}';
  v_num bigint;
  v_old_data jsonb;
  v_new_data jsonb;
begin
  perform public.ensure_manager();
  if p_operation_date>current_date then raise exception 'Дата операции не может быть в будущем'; end if;
  select * into v_old from public.operations where id=p_operation_id and workspace_id=v_workspace for update;
  if not found then raise exception 'Операция не найдена'; end if;
  if v_old.role='AUTO_REPLENISH' then raise exception 'Исторический автоприход редактировать нельзя'; end if;
  if v_old.status<>'CONFIRMED' then raise exception 'Можно редактировать только подтверждённую операцию'; end if;
  if not exists(select 1 from public.contractors where id=p_contractor_id and workspace_id=v_workspace) then raise exception 'Контрагент не найден'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Нет товаров для операции'; end if;

  select array_agg(distinct product_id) into v_old_products from public.operation_items where operation_id=p_operation_id;
  v_old_data:=jsonb_build_object('status',v_old.status,'version',v_old.version,'type',v_old.type,'role',v_old.role,'date',v_old.operation_date,'contractor_id',v_old.contractor_id,'items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',oi.product_id,'kg',oi.quantity_kg,'price',oi.unit_price,'wasteKg',oi.waste_kg) order by oi.product_id),'[]'::jsonb) from public.operation_items oi where oi.operation_id=p_operation_id),'note',v_old.note);

  for v_item_row in select value from jsonb_array_elements(p_items) as t(value) loop
    v_product_id:=nullif(v_item_row.value->>'product_id','')::uuid;
    v_name:=trim(v_item_row.value->>'name');
    v_qty:=(v_item_row.value->>'kg')::numeric;
    v_price:=(v_item_row.value->>'price')::numeric;
    v_waste:=coalesce((v_item_row.value->>'wasteKg')::numeric,0);
    if v_product_id is null then select id into v_product_id from public.products where workspace_id=v_workspace and lower(name)=lower(v_name) and status='ACTIVE'; end if;
    if v_product_id is null then raise exception 'Товар не найден: %',coalesce(v_name,''); end if;
    if v_qty is null or v_qty<=0 then raise exception 'Количество должно быть больше 0'; end if;
    if v_price is null or v_price<0 then raise exception 'Цена не может быть отрицательной'; end if;
    if v_price>1000000000 then raise exception 'Цена слишком большая'; end if;
    if v_waste<0 or v_waste>v_qty then raise exception 'Отход не может быть больше количества'; end if;
    if v_product_id=any(v_seen) then raise exception 'Товар указан в операции более одного раза'; end if;
    v_seen:=array_append(v_seen,v_product_id);
  end loop;

  select array_agg(distinct product_id order by product_id) into v_all_products
    from unnest(coalesce(v_old_products,'{}'::uuid[]) || coalesce(v_seen,'{}'::uuid[])) as t(product_id);
  if v_all_products is not null then
    foreach v_product in array v_all_products loop
      perform public.lock_product(v_workspace,v_product);
    end loop;
  end if;

  delete from public.operation_items where operation_id=p_operation_id;
  v_num:=case when v_old.operation_date=p_operation_date then v_old.operation_number else public.next_operation_number(v_workspace,p_operation_date) end;
  update public.operations set contractor_id=p_contractor_id,operation_date=p_operation_date,operation_number=v_num,updated_at=now(),note=p_note,version=v_old.version+1 where id=p_operation_id;

  for v_item_row in select value from jsonb_array_elements(p_items) as t(value) loop
    v_product_id:=nullif(v_item_row.value->>'product_id','')::uuid;
    v_name:=trim(v_item_row.value->>'name');
    if v_product_id is null then select id into v_product_id from public.products where workspace_id=v_workspace and lower(name)=lower(v_name) and status='ACTIVE'; end if;
    v_qty:=(v_item_row.value->>'kg')::numeric; v_price:=(v_item_row.value->>'price')::numeric; v_waste:=coalesce((v_item_row.value->>'wasteKg')::numeric,0);
    insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg) values(v_workspace,p_operation_id,v_product_id,v_qty,v_price,v_waste);
  end loop;
  select array_agg(distinct product_id order by product_id) into v_new_products from public.operation_items where operation_id=p_operation_id;
  select array_agg(distinct product_id order by product_id) into v_all_products
    from unnest(coalesce(v_old_products,'{}'::uuid[]) || coalesce(v_new_products,'{}'::uuid[])) as t(product_id);
  if v_all_products is not null then
    foreach v_product in array v_all_products loop
      perform public.rebuild_product_valuation(v_product,v_workspace);
    end loop;
  end if;

  v_new_data:=jsonb_build_object('status','CONFIRMED','version',v_old.version+1,'type',v_old.type,'role',v_old.role,'date',p_operation_date,'contractor_id',p_contractor_id,'items',p_items,'note',p_note);
  insert into public.audit_log(workspace_id,action,operation_id,user_id,old_data,new_data,details) values(v_workspace,'ИЗМЕНЕНИЕ ОПЕРАЦИИ',p_operation_id,auth.uid(),v_old_data,v_new_data,'БЫЛО → СТАЛО');
  return p_operation_id;
end; $$;

-- Reports must ignore cancelled operations.
create or replace function public.get_profit_report(p_from date default null,p_to date default null)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_catalog as $$
declare v_workspace uuid:=public.current_workspace_id(); v_from date:=coalesce(p_from,'1900-01-01'::date); v_to date:=coalesce(p_to,current_date); v_result jsonb;
begin
 select jsonb_build_object(
  'totals',jsonb_build_object('in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.total_amount else 0 end),0),'in_kg',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.quantity_kg else 0 end),0),'out_sum',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount else 0 end),0),'out_kg',coalesce(sum(case when o.type='SHIPMENT' then oi.quantity_kg else 0 end),0),'cogs',coalesce(sum(case when o.type='SHIPMENT' then oi.cogs_amount else 0 end),0),'profit',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount-oi.cogs_amount else 0 end),0)),
  'products',coalesce((select jsonb_agg(x order by (x->>'out_sum')::numeric desc) from (select jsonb_build_object('name',p.name,'in_kg',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.quantity_kg else 0 end),0),'in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.total_amount else 0 end),0),'out_kg',coalesce(sum(case when o.type='SHIPMENT' then oi.quantity_kg else 0 end),0),'out_sum',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount else 0 end),0),'cogs',coalesce(sum(case when o.type='SHIPMENT' then oi.cogs_amount else 0 end),0),'profit',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount-oi.cogs_amount else 0 end),0)) x from operation_items oi join operations o on o.id=oi.operation_id join products p on p.id=oi.product_id where oi.workspace_id=v_workspace and o.operation_date between v_from and v_to and o.status='CONFIRMED' group by p.id,p.name) q),'[]'::jsonb),
  'clients',coalesce((select jsonb_agg(x order by (x->>'out_sum')::numeric desc) from (select jsonb_build_object('name',c.name,'group',g.name,'in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.total_amount else 0 end),0),'out_sum',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount else 0 end),0),'cogs',coalesce(sum(case when o.type='SHIPMENT' then oi.cogs_amount else 0 end),0),'profit',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount-oi.cogs_amount else 0 end),0)) x from operations o join operation_items oi on oi.operation_id=o.id join contractors c on c.id=o.contractor_id left join contractor_groups g on g.id=c.group_id where o.workspace_id=v_workspace and o.operation_date between v_from and v_to and o.status='CONFIRMED' and o.role<>'AUTO_REPLENISH' group by c.id,c.name,g.name) q),'[]'::jsonb),
  'groups',coalesce((select jsonb_agg(x order by (x->>'out_sum')::numeric desc) from (select jsonb_build_object('name',g.name,'in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.total_amount else 0 end),0),'out_sum',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount else 0 end),0),'cogs',coalesce(sum(case when o.type='SHIPMENT' then oi.cogs_amount else 0 end),0),'profit',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount-oi.cogs_amount else 0 end),0)) x from operations o join operation_items oi on oi.operation_id=o.id join contractors c on c.id=o.contractor_id join contractor_groups g on g.id=c.group_id where o.workspace_id=v_workspace and o.operation_date between v_from and v_to and o.status='CONFIRMED' and o.role<>'AUTO_REPLENISH' group by g.id,g.name) q),'[]'::jsonb)
 ) into v_result; return v_result; end; $$;

commit;
