-- Обычная розничная продажа без контрагента.
-- Для ARRIVAL контрагент по-прежнему обязателен. Для SHIPMENT NULL означает обычную продажу.
alter table public.operations alter column contractor_id drop not null;

create or replace function public.post_operation(p_type public.operation_type,p_contractor_id uuid,p_operation_date date,p_items jsonb,p_note text default null)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare
 v_workspace uuid:=public.current_workspace_id(); v_id uuid; v_num bigint; v_item jsonb; v_product uuid; v_seen uuid[]:='{}'; v_name text; v_qty numeric; v_price numeric; v_waste numeric; v_role public.operation_role;
begin
 if v_workspace is null then raise exception 'Пользователь не авторизован'; end if;
 if p_operation_date>current_date then raise exception 'Дата операции не может быть в будущем'; end if;
 if p_type='ARRIVAL' and (p_contractor_id is null or not exists(select 1 from public.contractors where id=p_contractor_id and workspace_id=v_workspace)) then raise exception 'Для приёмки контрагент обязателен'; end if;
 if p_type='SHIPMENT' and p_contractor_id is not null and not exists(select 1 from public.contractors where id=p_contractor_id and workspace_id=v_workspace) then raise exception 'Контрагент не найден'; end if;
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Нет товаров для операции'; end if;
 v_role:=case when p_type='ARRIVAL' then 'ARRIVAL' else 'SHIPMENT' end; v_num:=public.next_operation_number(v_workspace,p_operation_date);
 insert into public.operations(workspace_id,operation_number,operation_date,type,role,contractor_id,created_by,note) values(v_workspace,v_num,p_operation_date,p_type,v_role,p_contractor_id,auth.uid(),p_note) returning id into v_id;
 for v_item in select * from jsonb_array_elements(p_items) loop
  v_name:=trim(v_item->>'name'); v_product:=nullif(v_item->>'product_id','')::uuid; v_qty:=(v_item->>'kg')::numeric; v_price:=(v_item->>'price')::numeric; v_waste:=coalesce((v_item->>'wasteKg')::numeric,0);
  if v_product is null then select id into v_product from public.products where workspace_id=v_workspace and lower(name)=lower(v_name) and status='ACTIVE'; end if;
  if v_product is null then raise exception 'Товар не найден: %',coalesce(v_name,''); end if;
  if v_qty is null or v_qty<=0 then raise exception 'Количество должно быть больше 0'; end if; if v_price is null or v_price<0 then raise exception 'Цена не может быть отрицательной'; end if; if v_waste<0 or v_waste>v_qty then raise exception 'Отход не может быть больше количества'; end if;
  if v_product=any(v_seen) then raise exception 'Товар указан в операции более одного раза: %',coalesce(v_name,v_product::text); end if; v_seen:=array_append(v_seen,v_product);
  if p_type='SHIPMENT' then perform public.lock_product(v_workspace,v_product); end if;
  insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg) values(v_workspace,v_id,v_product,v_qty,v_price,v_waste);
 end loop;
 for v_product in select distinct product_id from public.operation_items where operation_id=v_id order by product_id loop perform public.rebuild_product_valuation(v_product,v_workspace); end loop;
 insert into public.audit_log(workspace_id,action,operation_id,user_id,new_data,details) values(v_workspace,case when p_type='ARRIVAL' then 'СОЗДАНИЕ ПРИХОДА' else 'СОЗДАНИЕ ПРОДАЖИ / ОТГРУЗКИ' end,v_id,auth.uid(),jsonb_build_object('type',p_type,'date',p_operation_date,'contractor_id',p_contractor_id,'items',p_items),'Создание операции');
 return v_id;
end; $$;

create or replace function public.update_operation(p_operation_id uuid,p_contractor_id uuid,p_operation_date date,p_items jsonb,p_note text default null)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_workspace uuid:=public.current_workspace_id(); v_old public.operations%rowtype; v_old_products uuid[]; v_new_products uuid[]; v_product uuid; v_item jsonb; v_product_id uuid; v_name text; v_qty numeric; v_price numeric; v_waste numeric; v_seen uuid[]:='{}'; v_num bigint; v_old_data jsonb; v_new_data jsonb;
begin
 if v_workspace is null then raise exception 'Пользователь не авторизован'; end if; if p_operation_date>current_date then raise exception 'Дата операции не может быть в будущем'; end if;
 select * into v_old from public.operations where id=p_operation_id and workspace_id=v_workspace for update; if not found then raise exception 'Операция не найдена'; end if; if v_old.role='AUTO_REPLENISH' then raise exception 'Технический автоприход редактировать нельзя'; end if;
 if v_old.type='ARRIVAL' and (p_contractor_id is null or not exists(select 1 from public.contractors where id=p_contractor_id and workspace_id=v_workspace)) then raise exception 'Для приёмки контрагент обязателен'; end if;
 if v_old.type='SHIPMENT' and p_contractor_id is not null and not exists(select 1 from public.contractors where id=p_contractor_id and workspace_id=v_workspace) then raise exception 'Контрагент не найден'; end if;
 select array_agg(distinct product_id) into v_old_products from public.operation_items where operation_id=p_operation_id;
 v_old_data:=jsonb_build_object('type',v_old.type,'role',v_old.role,'date',v_old.operation_date,'contractor_id',v_old.contractor_id,'items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',oi.product_id,'kg',oi.quantity_kg,'price',oi.unit_price,'wasteKg',oi.waste_kg) order by oi.product_id),'[]'::jsonb) from public.operation_items oi where oi.operation_id=p_operation_id),'note',v_old.note);
 for v_item in select * from jsonb_array_elements(p_items) loop
  v_product_id:=nullif(v_item->>'product_id','')::uuid; v_name:=trim(v_item->>'name'); v_qty:=(v_item->>'kg')::numeric; v_price:=(v_item->>'price')::numeric; v_waste:=coalesce((v_item->>'wasteKg')::numeric,0);
  if v_product_id is null then select id into v_product_id from public.products where workspace_id=v_workspace and lower(name)=lower(v_name) and status='ACTIVE'; end if;
  if v_product_id is null then raise exception 'Товар не найден: %',coalesce(v_name,''); end if;
  if v_qty is null or v_qty<=0 then raise exception 'Количество должно быть больше 0'; end if; if v_price is null or v_price<0 then raise exception 'Цена не может быть отрицательной'; end if; if v_waste<0 or v_waste>v_qty then raise exception 'Отход не может быть больше количества'; end if;
  if v_product_id=any(v_seen) then raise exception 'Товар указан в операции более одного раза: %',coalesce(v_name,v_product_id::text); end if; v_seen:=array_append(v_seen,v_product_id);
  v_new_products:=array_append(coalesce(v_new_products,'{}'),v_product_id); if v_old.type='SHIPMENT' then perform public.lock_product(v_workspace,v_product_id); end if;
 end loop;
 foreach v_product in array coalesce(v_old_products,'{}'::uuid[]) loop perform public.lock_product(v_workspace,v_product); end loop;
 delete from public.operation_items where operation_id=p_operation_id;
 for v_item in select * from jsonb_array_elements(p_items) loop v_product_id:=nullif(v_item->>'product_id','')::uuid; v_name:=trim(v_item->>'name'); if v_product_id is null then select id into v_product_id from public.products where workspace_id=v_workspace and lower(name)=lower(v_name) and status='ACTIVE'; end if; v_qty:=(v_item->>'kg')::numeric; v_price:=(v_item->>'price')::numeric; v_waste:=coalesce((v_item->>'wasteKg')::numeric,0); insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg) values(v_workspace,p_operation_id,v_product_id,v_qty,v_price,v_waste); end loop;
 v_num:=public.next_operation_number(v_workspace,p_operation_date); update public.operations set contractor_id=p_contractor_id,operation_date=p_operation_date,operation_number=v_num,updated_at=now(),note=p_note where id=p_operation_id;
 foreach v_product in array coalesce(v_old_products,'{}'::uuid[]) loop perform public.rebuild_product_valuation(v_product,v_workspace); end loop;
 foreach v_product in array coalesce(v_new_products,'{}'::uuid[]) loop if not (v_product=any(coalesce(v_old_products,'{}'::uuid[]))) then perform public.rebuild_product_valuation(v_product,v_workspace); end if; end loop;
 v_new_data:=jsonb_build_object('type',v_old.type,'role',v_old.role,'date',p_operation_date,'contractor_id',p_contractor_id,'items',p_items,'note',p_note);
 update public.operations set version=version+1 where id=p_operation_id;
 insert into public.audit_log(workspace_id,action,operation_id,user_id,old_data,new_data,details) values(v_workspace,'ИЗМЕНЕНИЕ ОПЕРАЦИИ',p_operation_id,auth.uid(),v_old_data,v_new_data,'Изменение операции');
 return p_operation_id;
end; $$;
