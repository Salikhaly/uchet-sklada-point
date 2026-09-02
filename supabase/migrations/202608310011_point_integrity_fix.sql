begin;

-- Fix Point valuation: the Angar valuation function validates against current_workspace_id(),
-- while Point operations must validate against current_point_workspace_id().
create or replace function public.rebuild_point_product_valuation(p_product_id uuid,p_point_workspace_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  r record;
  v_qty numeric(16,3):=0;
  v_cost numeric(18,2):=0;
  v_avg numeric(18,8):=0;
  v_cogs numeric(18,2):=0;
begin
  if p_point_workspace_id is null or p_point_workspace_id<>public.current_point_workspace_id() then
    raise exception 'Нет доступа к Точке';
  end if;
  perform public.lock_product(p_point_workspace_id,p_product_id);
  for r in
    select o.id operation_id,o.type,o.role,o.status,o.operation_date,o.created_at,
           i.id item_id,i.quantity_kg,i.unit_price
    from public.operations o
    join public.operation_items i on i.operation_id=o.id
    where o.workspace_id=p_point_workspace_id
      and i.workspace_id=p_point_workspace_id
      and i.product_id=p_product_id
      and coalesce(o.status,'CONFIRMED')<>'CANCELLED'
    order by o.operation_date,o.created_at,o.id
  loop
    if r.role='AUTO_REPLENISH' or r.type='ARRIVAL' then
      v_qty:=v_qty+r.quantity_kg;
      v_cost:=v_cost+round(r.quantity_kg*r.unit_price,2);
      v_cogs:=0;
    else
      if v_qty+0.000001<r.quantity_kg then
        raise exception 'Недостаточный остаток товара % на операции %: доступно %, требуется %',
          p_product_id,r.operation_id,round(v_qty,3),round(r.quantity_kg,3);
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
  values(p_point_workspace_id,p_product_id,greatest(0,v_qty),greatest(0,v_cost),now())
  on conflict(workspace_id,product_id)
  do update set quantity_kg=excluded.quantity_kg,
                cost_amount=excluded.cost_amount,
                updated_at=now();
end; $$;

grant execute on function public.rebuild_point_product_valuation(uuid,uuid) to authenticated;

create or replace function public.rebuild_all_point_inventory_for_operation(p_operation_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  r record;
  v_ws uuid;
begin
  select workspace_id into v_ws from public.operations where id=p_operation_id;
  if v_ws is null or v_ws<>public.current_point_workspace_id() then raise exception 'Нет доступа к Точке'; end if;
  for r in select distinct product_id from public.operation_items where operation_id=p_operation_id loop
    perform public.rebuild_point_product_valuation(r.product_id,v_ws);
  end loop;
end; $$;

grant execute on function public.rebuild_all_point_inventory_for_operation(uuid) to authenticated;

-- Fix the undeclared idempotency variable and lock products during shipment/sale.
create or replace function public.point_post_operation(
  p_type text,p_contractor_id uuid,p_operation_date date,p_items jsonb,
  p_note text default null,p_idempotency_key uuid default null)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_ws uuid:=public.current_point_workspace_id();
  v_num bigint; v_id uuid; v_existing uuid;
  v_role public.operation_role; v_item jsonb; v_product uuid;
  v_qty numeric; v_price numeric; v_waste numeric; v_available numeric;
begin
  perform public.ensure_point_member();
  if p_type not in ('ARRIVAL','SHIPMENT','SALE') then raise exception 'Неизвестный тип операции'; end if;
  if p_idempotency_key is not null then
    select id into v_existing from public.operations
      where workspace_id=v_ws and idempotency_key=p_idempotency_key;
    if v_existing is not null then return v_existing; end if;
  end if;
  if p_operation_date>current_date then raise exception 'Дата не может быть в будущем'; end if;
  if p_type in ('SHIPMENT','SALE') and p_contractor_id is null then raise exception 'Нужен получатель'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Нет товаров для операции'; end if;

  v_role:=case when p_type='ARRIVAL' then 'ARRIVAL'::public.operation_role else 'SHIPMENT'::public.operation_role end;
  v_num:=public.next_operation_number(v_ws,p_operation_date);
  insert into public.operations(
    workspace_id,operation_number,operation_date,type,role,status,version,idempotency_key,
    contractor_id,created_by,note)
  values(
    v_ws,v_num,p_operation_date,
    case when p_type='SALE' then 'SHIPMENT'::public.operation_type else p_type::public.operation_type end,
    v_role,'CONFIRMED',1,p_idempotency_key,p_contractor_id,auth.uid(),
    case when p_type='SALE' then '[SALE] '||coalesce(p_note,'') else p_note end)
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_product:=(v_item->>'product_id')::uuid;
    v_qty:=round((v_item->>'kg')::numeric,3);
    v_price:=round((v_item->>'price')::numeric,2);
    v_waste:=coalesce(round((v_item->>'wasteKg')::numeric,3),0);
    if not exists(select 1 from public.products where id=v_product and workspace_id=v_ws and status='ACTIVE') then
      raise exception 'Товар не найден';
    end if;
    if v_qty<=0 or v_price<0 or v_waste<0 or v_waste>v_qty then
      raise exception 'Некорректная строка операции';
    end if;
    if p_type in ('SHIPMENT','SALE') then
      perform public.lock_product(v_ws,v_product);
      select quantity_kg into v_available from public.inventory_balances
        where workspace_id=v_ws and product_id=v_product;
      if coalesce(v_available,0)+0.000001<v_qty then
        raise exception 'Недостаточный остаток: доступно % кг, указано % кг',
          round(coalesce(v_available,0),3),round(v_qty,3);
      end if;
    end if;
    insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg)
      values(v_ws,v_id,v_product,v_qty,v_price,v_waste);
  end loop;

  perform public.rebuild_all_point_inventory_for_operation(v_id);
  insert into public.audit_log(workspace_id,action,operation_id,user_id,new_data,details)
  values(v_ws,
    case when p_type='ARRIVAL' then 'ТОЧКА: СОЗДАНИЕ ПРИХОДА'
         when p_type='SALE' then 'ТОЧКА: СОЗДАНИЕ ПРОДАЖИ'
         else 'ТОЧКА: СОЗДАНИЕ ОТГРУЗКИ' end,
    v_id,auth.uid(),
    jsonb_build_object('type',p_type,'date',p_operation_date,'contractor_id',p_contractor_id,'items',p_items),
    'Операция Точки');
  return v_id;
end; $$;

grant execute on function public.point_post_operation(text,uuid,date,jsonb,text,uuid) to authenticated;

-- A transfer can contain several products. Keep one batch id, but give every row its own PK.
alter table public.point_transfers
  add column if not exists transfer_group_id uuid;
update public.point_transfers
  set transfer_group_id=id
  where transfer_group_id is null;
create index if not exists point_transfers_group_idx
  on public.point_transfers(transfer_group_id,created_at desc);


create or replace function public.point_transfer_to_angar(p_items jsonb,p_date date)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_point uuid:=public.current_point_workspace_id();
  v_angar uuid;
  v_transfer uuid:=gen_random_uuid();
  v_item jsonb;
  v_ppid uuid;
  v_apid uuid;
  v_name text;
  v_qty numeric;
  v_avg numeric;
  v_point_op uuid;
  v_angar_op uuid;
  v_num bigint;
  v_count int:=0;
  v_out_items jsonb:='[]'::jsonb;
  v_in_items jsonb:='[]'::jsonb;
begin
  perform public.ensure_point_member();
  if exists(select 1 from public.point_evening_summaries where workspace_id=v_point and summary_date=p_date and status='CLOSED') then
    raise exception 'День уже закрыт';
  end if;
  select workspace_id into v_angar from public.profiles where id=auth.uid();
  if v_angar is null or v_angar=v_point then raise exception 'Не найден склад Ангар'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_ppid:=(v_item->>'product_id')::uuid;
    v_qty:=round((v_item->>'kg')::numeric,3);
    select p.name,coalesce(i.quantity_kg,0),coalesce(i.avg_cost,0)
      into v_name,v_qty,v_avg
      from public.products p
      left join public.inventory_balances i on i.product_id=p.id and i.workspace_id=v_point
      where p.id=v_ppid and p.workspace_id=v_point;
    v_qty:=round((v_item->>'kg')::numeric,3);
    if v_name is null then raise exception 'Товар Точки не найден'; end if;
    if v_qty<=0 then raise exception 'Количество должно быть больше нуля'; end if;
    if coalesce((select quantity_kg from public.inventory_balances where workspace_id=v_point and product_id=v_ppid),0)+0.000001<v_qty then
      raise exception 'Недостаточный остаток %: доступно % кг, указано % кг',v_name,
        round(coalesce((select quantity_kg from public.inventory_balances where workspace_id=v_point and product_id=v_ppid),0),3),round(v_qty,3);
    end if;
    perform public.lock_product(v_point,v_ppid);
    select id into v_apid from public.products where workspace_id=v_angar and lower(name)=lower(v_name) limit 1;
    if v_apid is null then raise exception 'Товар % отсутствует в Ангаре',v_name; end if;
    v_out_items:=v_out_items||jsonb_build_array(jsonb_build_object('product_id',v_ppid,'kg',v_qty,'price',v_avg,'wasteKg',0));
    v_in_items:=v_in_items||jsonb_build_array(jsonb_build_object('product_id',v_apid,'kg',v_qty,'price',v_avg,'wasteKg',0));
    insert into public.point_transfers(id,transfer_group_id,point_workspace_id,angar_workspace_id,product_name,quantity_kg,unit_cost,created_by)
      values(gen_random_uuid(),v_transfer,v_point,v_angar,v_name,v_qty,v_avg,auth.uid());
    v_count:=v_count+1;
  end loop;
  if v_count=0 then raise exception 'Добавьте товар для перемещения'; end if;

  v_num:=public.next_operation_number(v_point,p_date);
  select id into v_point_op from public.contractors where workspace_id=v_point and lower(name)=lower('Внутреннее перемещение') limit 1;
  if v_point_op is null then insert into public.contractors(workspace_id,name) values(v_point,'Внутреннее перемещение') returning id into v_point_op; end if;
  insert into public.operations(workspace_id,operation_number,operation_date,type,role,contractor_id,created_by,note)
    values(v_point,v_num,p_date,'SHIPMENT','SHIPMENT',v_point_op,auth.uid(),'[TRANSFER_TO_ANGAR] transfer_id='||v_transfer::text)
    returning id into v_point_op;
  for v_item in select * from jsonb_array_elements(v_out_items) loop
    insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg)
      values(v_point,v_point_op,(v_item->>'product_id')::uuid,(v_item->>'kg')::numeric,(v_item->>'price')::numeric,0);
  end loop;
  perform public.rebuild_all_point_inventory_for_operation(v_point_op);

  v_num:=public.next_operation_number(v_angar,p_date);
  select id into v_angar_op from public.contractors where workspace_id=v_angar and lower(name)=lower('Внутреннее перемещение') limit 1;
  if v_angar_op is null then insert into public.contractors(workspace_id,name) values(v_angar,'Внутреннее перемещение') returning id into v_angar_op; end if;
  insert into public.operations(workspace_id,operation_number,operation_date,type,role,contractor_id,created_by,note)
    values(v_angar,v_num,p_date,'ARRIVAL','ARRIVAL',v_angar_op,auth.uid(),'[TRANSFER_FROM_POINT] transfer_id='||v_transfer::text)
    returning id into v_angar_op;
  for v_item in select * from jsonb_array_elements(v_in_items) loop
    insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg)
      values(v_angar,v_angar_op,(v_item->>'product_id')::uuid,(v_item->>'kg')::numeric,(v_item->>'price')::numeric,0);
  end loop;
  for v_item in select * from jsonb_array_elements(v_in_items) loop
    perform public.rebuild_product_valuation((v_item->>'product_id')::uuid,v_angar);
  end loop;

  update public.point_transfers set point_operation_id=v_point_op,angar_operation_id=v_angar_op where transfer_group_id=v_transfer;
  insert into public.audit_log(workspace_id,action,operation_id,related_operation_id,user_id,details,new_data)
    values(v_point,'ТОЧКА: ПЕРЕМЕЩЕНИЕ В АНГАР',v_point_op,v_angar_op,auth.uid(),'Атомарное перемещение',jsonb_build_object('transfer_id',v_transfer,'date',p_date,'items',p_items));
  insert into public.audit_log(workspace_id,action,operation_id,related_operation_id,user_id,details,new_data)
    values(v_angar,'АНГАР: ПРИХОД ИЗ ТОЧКИ',v_angar_op,v_point_op,auth.uid(),'Связанное перемещение из Точки',jsonb_build_object('transfer_id',v_transfer));
  return jsonb_build_object('transfer_id',v_transfer,'point_operation_id',v_point_op,'angar_operation_id',v_angar_op);
end; $$;

grant execute on function public.point_transfer_to_angar(jsonb,date) to authenticated;

commit;
