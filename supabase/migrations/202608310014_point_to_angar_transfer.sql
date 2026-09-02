begin;

-- A transfer is still a real stock movement, but it must not look like a sale.
alter table public.operations
  add column if not exists transfer_id uuid,
  add column if not exists transfer_side text;

create index if not exists operations_transfer_idx on public.operations(transfer_id) where transfer_id is not null;

drop function if exists public.rebuild_product_valuation_unchecked(uuid,uuid);
create or replace function public.rebuild_product_valuation_unchecked(p_product_id uuid,p_workspace_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare r record; v_qty numeric(16,3):=0; v_cost numeric(18,2):=0; v_avg numeric(18,8):=0; v_cogs numeric(18,2):=0;
begin
  perform public.lock_product(p_workspace_id,p_product_id);
  for r in
    select o.id operation_id,o.type,o.role,o.operation_date,o.created_at,i.id item_id,i.quantity_kg,i.unit_price
    from public.operations o
    join public.operation_items i on i.operation_id=o.id
    where o.workspace_id=p_workspace_id and i.workspace_id=p_workspace_id and i.product_id=p_product_id
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
  on conflict(workspace_id,product_id) do update
  set quantity_kg=excluded.quantity_kg,cost_amount=excluded.cost_amount,updated_at=now();
end; $$;
revoke execute on function public.rebuild_product_valuation_unchecked(uuid,uuid) from public,authenticated,anon;

create or replace function public.transfer_point_to_angar(
  p_product_id uuid,
  p_quantity_kg numeric,
  p_date date default current_date,
  p_note text default ''
) returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_uid uuid:=auth.uid();
  v_profile public.profiles%rowtype;
  v_point_ws uuid;
  v_angar_ws uuid;
  v_angar_product uuid;
  v_qty numeric(16,3);
  v_cost numeric(18,2);
  v_avg numeric(18,8);
  v_transfer uuid:=gen_random_uuid();
  v_point_contractor uuid;
  v_angar_contractor uuid;
  v_point_op uuid;
  v_angar_op uuid;
  v_num bigint;
  v_name text;
  v_item jsonb;
begin
  if v_uid is null then raise exception 'Пользователь не авторизован'; end if;
  if p_quantity_kg is null or p_quantity_kg<=0 then raise exception 'Количество для перемещения должно быть больше нуля'; end if;
  if p_date>current_date then raise exception 'Дата перемещения не может быть в будущем'; end if;

  select * into v_profile from public.profiles where id=v_uid for update;
  if not found then raise exception 'Профиль пользователя не найден'; end if;
  if v_profile.active_mode<>'POINT' or v_profile.point_workspace_id is null then raise exception 'Перемещение в Ангар доступно только из режима Точка'; end if;
  v_point_ws:=v_profile.point_workspace_id; v_angar_ws:=v_profile.workspace_id;

  select name into v_name from public.products where id=p_product_id and workspace_id=v_point_ws and status='ACTIVE';
  if v_name is null then raise exception 'Товар не найден в Точке'; end if;
  select id into v_angar_product from public.products where workspace_id=v_angar_ws and lower(name)=lower(v_name) limit 1;
  if v_angar_product is null then raise exception 'В Ангаре не найден товар «%»',v_name; end if;

  perform public.rebuild_product_valuation(p_product_id,v_point_ws);
  select quantity_kg,cost_amount into v_qty,v_cost from public.inventory_balances where workspace_id=v_point_ws and product_id=p_product_id for update;
  v_qty:=coalesce(v_qty,0); v_cost:=coalesce(v_cost,0);
  if v_qty+0.000001 < p_quantity_kg then raise exception 'Недостаточный остаток: доступно %, указано % кг',round(v_qty,3),round(p_quantity_kg,3); end if;
  v_avg:=case when v_qty>0 then round(v_cost/v_qty,8) else 0 end;

  -- Stable technical contractors keep the legacy operation schema intact.
  insert into public.contractors(workspace_id,name)
    values(v_point_ws,'Перемещение в Ангар')
  on conflict(workspace_id,lower(name)) do update set name=excluded.name
  returning id into v_point_contractor;
  insert into public.contractors(workspace_id,name)
    values(v_angar_ws,'Перемещение из Точки')
  on conflict(workspace_id,lower(name)) do update set name=excluded.name
  returning id into v_angar_contractor;

  -- Point side: a shipment priced exactly at current average cost, so it creates no sale profit.
  v_item:=jsonb_build_array(jsonb_build_object('product_id',p_product_id,'name',v_name,'kg',p_quantity_kg,'price',v_avg,'wasteKg',0));
  v_point_op:=public.post_operation('SHIPMENT',v_point_contractor,p_date,v_item,coalesce(nullif(trim(p_note),''),'Перемещение товара в Ангар'));
  update public.operations set transfer_id=v_transfer,transfer_side='OUT',note=coalesce(nullif(trim(p_note),''),'Перемещение товара в Ангар') where id=v_point_op;

  -- Angar side: receive the exact same kilograms at the same purchase/average cost.
  v_num:=public.next_operation_number(v_angar_ws,p_date);
  insert into public.operations(workspace_id,operation_number,operation_date,type,role,contractor_id,created_by,note,transfer_id,transfer_side)
  values(v_angar_ws,v_num,p_date,'ARRIVAL','ARRIVAL',v_angar_contractor,v_uid,coalesce(nullif(trim(p_note),''),'Перемещение товара из Точки'),v_transfer,'IN')
  returning id into v_angar_op;
  insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg,cogs_amount)
  values(v_angar_ws,v_angar_op,v_angar_product,p_quantity_kg,v_avg,0,0);
  perform public.rebuild_product_valuation_unchecked(v_angar_product,v_angar_ws);

  insert into public.audit_log(workspace_id,action,user_id,old_data,new_data,details)
  values
    (v_point_ws,'ПЕРЕМЕЩЕНИЕ В АНГАР',v_uid,jsonb_build_object('product_id',p_product_id,'kg',p_quantity_kg,'avg_cost',v_avg),jsonb_build_object('operation_id',v_point_op,'transfer_id',v_transfer),'Точка → Ангар'),
    (v_angar_ws,'ПРИЁМ ПЕРЕМЕЩЕНИЯ ИЗ ТОЧКИ',v_uid,null,jsonb_build_object('operation_id',v_angar_op,'transfer_id',v_transfer,'product_id',v_angar_product,'kg',p_quantity_kg,'avg_cost',v_avg),'Ангар ← Точка');

  return jsonb_build_object('transfer_id',v_transfer,'product_name',v_name,'point_operation_id',v_point_op,'angar_operation_id',v_angar_op,'quantity_kg',p_quantity_kg,'unit_cost',round(v_avg,2));
end; $$;
grant execute on function public.transfer_point_to_angar(uuid,numeric,date,text) to authenticated;

-- Keep transfers out of sales/client profit reports.
create or replace function public.get_profit_report(p_from date default null,p_to date default null) returns jsonb language plpgsql stable security invoker set search_path=public,pg_catalog as $$
declare v_workspace uuid:=public.current_workspace_id(); v_from date:=coalesce(p_from,'1900-01-01'::date); v_to date:=coalesce(p_to,current_date); v_result jsonb;
begin
 select jsonb_build_object(
  'totals',jsonb_build_object('in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' and o.transfer_id is null then oi.total_amount else 0 end),0),'in_kg',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' and o.transfer_id is null then oi.quantity_kg else 0 end),0),'out_sum',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.total_amount else 0 end),0),'out_kg',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.quantity_kg else 0 end),0),'cogs',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.cogs_amount else 0 end),0),'profit',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.total_amount-oi.cogs_amount else 0 end),0)),
  'products',coalesce((select jsonb_agg(x order by (x->>'out_sum')::numeric desc) from (select jsonb_build_object('name',p.name,'in_kg',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' and o.transfer_id is null then oi.quantity_kg else 0 end),0),'in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' and o.transfer_id is null then oi.total_amount else 0 end),0),'out_kg',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.quantity_kg else 0 end),0),'out_sum',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.total_amount else 0 end),0),'cogs',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.cogs_amount else 0 end),0),'profit',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.total_amount-oi.cogs_amount else 0 end),0)) x from operation_items oi join operations o on o.id=oi.operation_id join products p on p.id=oi.product_id where oi.workspace_id=v_workspace and o.operation_date between v_from and v_to and o.transfer_id is null group by p.id,p.name) q),'[]'::jsonb),
  'clients',coalesce((select jsonb_agg(x order by (x->>'out_sum')::numeric desc) from (select jsonb_build_object('name',c.name,'group',g.name,'in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' and o.transfer_id is null then oi.total_amount else 0 end),0),'out_sum',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.total_amount else 0 end),0),'cogs',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.cogs_amount else 0 end),0),'profit',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.total_amount-oi.cogs_amount else 0 end),0)) x from operations o join operation_items oi on oi.operation_id=o.id join contractors c on c.id=o.contractor_id left join contractor_groups g on g.id=c.group_id where o.workspace_id=v_workspace and o.operation_date between v_from and v_to and o.role<>'AUTO_REPLENISH' and o.transfer_id is null group by c.id,c.name,g.name) q),'[]'::jsonb),
  'groups',coalesce((select jsonb_agg(x order by (x->>'out_sum')::numeric desc) from (select jsonb_build_object('name',g.name,'in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' and o.transfer_id is null then oi.total_amount else 0 end),0),'out_sum',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.total_amount else 0 end),0),'cogs',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.cogs_amount else 0 end),0),'profit',coalesce(sum(case when o.type='SHIPMENT' and o.transfer_id is null then oi.total_amount-oi.cogs_amount else 0 end),0)) x from operations o join operation_items oi on oi.operation_id=o.id join contractors c on c.id=o.contractor_id join contractor_groups g on g.id=c.group_id where o.workspace_id=v_workspace and o.operation_date between v_from and v_to and o.role<>'AUTO_REPLENISH' and o.transfer_id is null group by g.id,g.name) q),'[]'::jsonb)
 ) into v_result;
 return v_result;
end; $$;
grant execute on function public.get_profit_report(date,date) to authenticated;

commit;
