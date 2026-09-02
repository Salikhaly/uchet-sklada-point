begin;

-- ============================================================
-- POINT V11 — remaining audit hardening
-- Safe/idempotent repair on top of V10.
-- Does not change Angar core operation semantics.
-- ============================================================

-- 1) Prevent duplicate transfer groups at DB level.
create unique index if not exists point_transfers_transfer_group_uq
  on public.point_transfers(transfer_group_id)
  where transfer_group_id is not null;

-- 2) Employee audit: preserve old state when reactivating/renaming.
create or replace function public.point_upsert_employee(p_name text)
returns uuid
language plpgsql security definer
set search_path=public,pg_catalog
as $$
declare
  v_ws uuid := public.current_point_workspace_id();
  v_id uuid;
  v_name text := trim(p_name);
  v_old jsonb;
begin
  perform public.ensure_point_member();
  if public.current_user_role() not in ('admin','manager') then
    raise exception 'Недостаточно прав';
  end if;
  if v_name is null or v_name='' then
    raise exception 'Имя сотрудника не может быть пустым';
  end if;

  select id,
         jsonb_build_object('id',id,'name',name,'active',active)
    into v_id,v_old
  from public.point_employees
  where workspace_id=v_ws
    and lower(trim(name))=lower(v_name)
  order by created_at
  limit 1;

  if v_id is null then
    insert into public.point_employees(workspace_id,name,active)
    values(v_ws,v_name,true)
    returning id into v_id;
  else
    update public.point_employees
       set name=v_name, active=true
     where id=v_id;
  end if;

  insert into public.audit_log(workspace_id,action,user_id,old_data,new_data,details)
  values(
    v_ws,
    'ТОЧКА: СОТРУДНИК',
    auth.uid(),
    v_old,
    jsonb_build_object('employee_id',v_id,'name',v_name,'active',true),
    case when v_old is null then 'Добавление сотрудника' else 'Изменение/активация сотрудника' end
  );

  return v_id;
end;
$$;
grant execute on function public.point_upsert_employee(text) to authenticated;

-- 3) Product audit: preserve old state and price changes.
create or replace function public.point_upsert_product(p_name text,p_price numeric)
returns uuid
language plpgsql security definer
set search_path=public,pg_catalog
as $$
declare
  v_ws uuid := public.current_point_workspace_id();
  v_id uuid;
  v_old_price numeric;
  v_name text := trim(p_name);
  v_price numeric := round(greatest(0,coalesce(p_price,0)),2);
  v_old jsonb;
begin
  perform public.ensure_point_member();
  if public.current_user_role() not in ('admin','manager') then
    raise exception 'Недостаточно прав';
  end if;
  if v_name is null or v_name='' then
    raise exception 'Название товара не может быть пустым';
  end if;

  select id,default_price,
         jsonb_build_object('id',id,'name',name,'default_price',default_price,'status',status,'sort_order',sort_order)
    into v_id,v_old_price,v_old
  from public.products
  where workspace_id=v_ws
    and lower(trim(name))=lower(v_name)
  order by created_at
  limit 1;

  if v_id is null then
    insert into public.products(workspace_id,name,default_price,status)
    values(v_ws,v_name,v_price,'ACTIVE')
    returning id into v_id;

    insert into public.price_history(workspace_id,product_id,old_price,new_price,source,changed_by)
    values(v_ws,v_id,0,v_price,'POINT_CREATE',auth.uid());
  else
    update public.products
       set default_price=v_price,status='ACTIVE',updated_at=now()
     where id=v_id;

    if round(coalesce(v_old_price,0),2) <> v_price then
      insert into public.price_history(workspace_id,product_id,old_price,new_price,source,changed_by)
      values(v_ws,v_id,round(coalesce(v_old_price,0),2),v_price,'POINT_MANUAL',auth.uid());
    end if;
  end if;

  insert into public.audit_log(workspace_id,action,user_id,old_data,new_data,details)
  values(
    v_ws,
    'ТОЧКА: ТОВАР',
    auth.uid(),
    v_old,
    jsonb_build_object('product_id',v_id,'name',v_name,'default_price',v_price,'status','ACTIVE'),
    case when v_old is null then 'Добавление товара' else 'Изменение товара' end
  );

  return v_id;
end;
$$;
grant execute on function public.point_upsert_product(text,numeric) to authenticated;

-- 4) Evening-summary save audit: keep the previous snapshot on updates.
create or replace function public.point_save_evening_summary(
  p_date date,
  p_opening_cash numeric,
  p_brought_cash numeric,
  p_actual_cash numeric,
  p_note text default null
)
returns uuid
language plpgsql security definer
set search_path=public,pg_catalog
as $$
declare
  v_ws uuid := public.current_point_workspace_id();
  v_id uuid;
  v_old jsonb;
  v_purchase numeric := 0;
  v_sales numeric := 0;
  v_expenses numeric := 0;
  v_expected numeric;
  v_variance numeric;
begin
  perform public.ensure_point_member();
  if p_date>current_date then
    raise exception 'Дата не может быть в будущем';
  end if;
  if coalesce(p_opening_cash,0)<0 or coalesce(p_brought_cash,0)<0 then
    raise exception 'Кассовые суммы не могут быть отрицательными';
  end if;
  if p_actual_cash is not null and p_actual_cash<0 then
    raise exception 'Фактическая касса не может быть отрицательной';
  end if;

  select
    id,
    jsonb_build_object(
      'id',id,
      'summary_date',summary_date,
      'status',status,
      'opening_cash',opening_cash,
      'brought_cash',brought_cash,
      'actual_cash',actual_cash,
      'expected_cash',expected_cash,
      'variance',variance,
      'note',note
    )
  into v_id,v_old
  from public.point_evening_summaries
  where workspace_id=v_ws and summary_date=p_date
  for update;

  if v_old ? 'status' and (v_old->>'status')='CLOSED' then
    raise exception 'День уже закрыт';
  end if;

  insert into public.point_evening_summaries(
    workspace_id,summary_date,opening_cash,brought_cash,actual_cash,note,created_by,updated_by
  )
  values(
    v_ws,p_date,greatest(0,coalesce(p_opening_cash,0)),greatest(0,coalesce(p_brought_cash,0)),p_actual_cash,p_note,auth.uid(),auth.uid()
  )
  on conflict(workspace_id,summary_date) do update set
    opening_cash=excluded.opening_cash,
    brought_cash=excluded.brought_cash,
    actual_cash=excluded.actual_cash,
    note=excluded.note,
    updated_by=auth.uid(),
    updated_at=now()
  returning id into v_id;

  perform public.point_recalculate_evening_cash(v_id);

  select coalesce(sum(oi.total_amount),0) into v_purchase
  from public.operations o join public.operation_items oi on oi.operation_id=o.id
  where o.workspace_id=v_ws and o.operation_date=p_date and o.role='ARRIVAL' and coalesce(o.status,'CONFIRMED')<>'CANCELLED';

  select coalesce(sum(oi.total_amount),0) into v_sales
  from public.operations o join public.operation_items oi on oi.operation_id=o.id
  where o.workspace_id=v_ws and o.operation_date=p_date and o.note like '[SALE]%' and coalesce(o.status,'CONFIRMED')<>'CANCELLED';

  select coalesce(sum(amount),0) into v_expenses
  from public.point_evening_expenses
  where summary_id=v_id;

  select expected_cash,variance into v_expected,v_variance
  from public.point_evening_summaries where id=v_id;

  insert into public.audit_log(workspace_id,action,user_id,old_data,new_data,details)
  values(
    v_ws,
    'ТОЧКА: СОХРАНЕНИЕ ВЕЧЕРНЕЙ СВОДКИ',
    auth.uid(),
    v_old,
    jsonb_build_object(
      'summary_id',v_id,
      'date',p_date,
      'purchase_amount',v_purchase,
      'sales_amount',v_sales,
      'expenses_amount',v_expenses,
      'expected_cash',v_expected,
      'actual_cash',p_actual_cash,
      'variance',v_variance
    ),
    'Вечерняя сводка'
  );

  return v_id;
end;
$$;
grant execute on function public.point_save_evening_summary(date,numeric,numeric,numeric,text) to authenticated;

-- 5) Reassert canonical transfer signatures; old overloads must not survive.
drop function if exists public.point_transfer_to_angar(jsonb,date);
drop function if exists public.point_transfer_to_angar(jsonb,date,uuid,text);
drop function if exists public.point_transfer_to_angar(uuid,numeric,text);

-- Existing canonical 4-arg body remains; no redefinition needed here.
grant execute on function public.point_transfer_to_angar(uuid,numeric,text,uuid) to authenticated;

-- 6) A quick verification view/function for admins.
create or replace function public.point_schema_health()
returns jsonb
language plpgsql
security definer
set search_path=public,pg_catalog
as $$
declare
  v_ws uuid := public.current_point_workspace_id();
  v_transfer_count integer := 0;
  v_employees integer := 0;
  v_products integer := 0;
begin
  perform public.ensure_point_member();
  select count(*) into v_transfer_count from public.point_transfers where point_workspace_id=v_ws;
  select count(*) into v_employees from public.point_employees where workspace_id=v_ws and active;
  select count(*) into v_products from public.products where workspace_id=v_ws and status='ACTIVE';
  return jsonb_build_object(
    'ok',true,
    'point_workspace_id',v_ws,
    'active_products',v_products,
    'active_employees',v_employees,
    'transfer_count',v_transfer_count,
    'generated_at',now()
  );
end;
$$;
grant execute on function public.point_schema_health() to authenticated;

commit;
