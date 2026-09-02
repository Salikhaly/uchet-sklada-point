begin;

-- ============================================================
-- POINT V10 REPAIR / CANONICALIZATION
-- Built against the real production schema verified in Supabase.
-- ANGAR core remains unchanged except delete_operation integration
-- for linked Point -> Angar transfers.
-- ============================================================

-- ---------- PROFILE / POINT TABLES ----------
alter table public.profiles
  add column if not exists point_workspace_id uuid
  references public.workspaces(id) on delete set null;

create table if not exists public.point_employees(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists point_employees_workspace_name_trim_uq
  on public.point_employees(workspace_id, lower(trim(name)));

create table if not exists public.point_evening_summaries(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  summary_date date not null,
  status text not null default 'DRAFT' check(status in ('DRAFT','CHECKED','CLOSED')),
  opening_cash numeric(18,2) not null default 0 check(opening_cash >= 0),
  brought_cash numeric(18,2) not null default 0 check(brought_cash >= 0),
  actual_cash numeric(18,2),
  expected_cash numeric(18,2),
  variance numeric(18,2),
  note text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, summary_date)
);

create table if not exists public.point_evening_expenses(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  summary_id uuid not null references public.point_evening_summaries(id) on delete cascade,
  employee_id uuid references public.point_employees(id) on delete set null,
  category text not null,
  comment text,
  amount numeric(18,2) not null check(amount > 0),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists point_evening_expenses_summary_idx
  on public.point_evening_expenses(summary_id, created_at desc);

create table if not exists public.point_transfers(
  id uuid primary key default gen_random_uuid(),
  point_workspace_id uuid not null references public.workspaces(id) on delete cascade,
  angar_workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_name text not null,
  quantity_kg numeric(16,3) not null check(quantity_kg > 0),
  unit_cost numeric(14,2) not null check(unit_cost >= 0),
  point_operation_id uuid references public.operations(id) on delete set null,
  angar_operation_id uuid references public.operations(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  transfer_group_id uuid
);

alter table public.point_transfers add column if not exists transfer_group_id uuid;
create index if not exists point_transfers_point_idx
  on public.point_transfers(point_workspace_id, created_at desc);
create index if not exists point_transfers_group_idx
  on public.point_transfers(transfer_group_id, created_at desc);

-- ---------- IDEMPOTENCY ----------
create unique index if not exists operations_workspace_idempotency_uq
  on public.operations(workspace_id, idempotency_key)
  where idempotency_key is not null;

-- ---------- POINT CONTEXT ----------
create or replace function public.current_point_workspace_id()
returns uuid
language sql stable security definer
set search_path=public,pg_catalog
as $$
  select point_workspace_id from public.profiles where id=auth.uid();
$$;
grant execute on function public.current_point_workspace_id() to authenticated;

create or replace function public.ensure_point_member()
returns void
language plpgsql stable security definer
set search_path=public,pg_catalog
as $$
begin
  if auth.uid() is null then
    raise exception 'Пользователь не авторизован';
  end if;
  if public.current_point_workspace_id() is null then
    raise exception 'Точка не привязана к профилю';
  end if;
end;
$$;
grant execute on function public.ensure_point_member() to authenticated;

-- ---------- POINT PRODUCT / EMPLOYEE ----------
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
begin
  perform public.ensure_point_member();
  if public.current_user_role() not in ('admin','manager') then raise exception 'Недостаточно прав'; end if;
  if v_name is null or v_name='' then raise exception 'Название товара не может быть пустым'; end if;

  select id, default_price into v_id, v_old_price
  from public.products
  where workspace_id=v_ws and lower(trim(name))=lower(v_name)
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

  insert into public.audit_log(workspace_id,action,user_id,new_data,details)
  values(v_ws,'ТОЧКА: ТОВАР',auth.uid(),jsonb_build_object('product_id',v_id,'name',v_name,'price',v_price),'Добавление/изменение товара');

  return v_id;
end;
$$;
grant execute on function public.point_upsert_product(text,numeric) to authenticated;

create or replace function public.point_upsert_employee(p_name text)
returns uuid
language plpgsql security definer
set search_path=public,pg_catalog
as $$
declare
  v_ws uuid := public.current_point_workspace_id();
  v_id uuid;
  v_name text := trim(p_name);
begin
  perform public.ensure_point_member();
  if public.current_user_role() not in ('admin','manager') then raise exception 'Недостаточно прав'; end if;
  if v_name is null or v_name='' then raise exception 'Имя сотрудника не может быть пустым'; end if;

  select id into v_id
  from public.point_employees
  where workspace_id=v_ws and lower(trim(name))=lower(v_name)
  order by created_at
  limit 1;

  if v_id is null then
    insert into public.point_employees(workspace_id,name,active)
    values(v_ws,v_name,true)
    returning id into v_id;
  else
    update public.point_employees set name=v_name,active=true where id=v_id;
  end if;

  insert into public.audit_log(workspace_id,action,user_id,new_data,details)
  values(v_ws,'ТОЧКА: СОТРУДНИК',auth.uid(),jsonb_build_object('employee_id',v_id,'name',v_name),'Добавление/активация сотрудника');

  return v_id;
end;
$$;
grant execute on function public.point_upsert_employee(text) to authenticated;

-- ---------- POINT VALUATION ----------
create or replace function public.rebuild_point_product_valuation(p_product_id uuid,p_point_workspace_id uuid)
returns void
language plpgsql security definer
set search_path=public,pg_catalog
as $$
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
        raise exception 'Недостаточный остаток товара % на операции %: доступно %, требуется %',p_product_id,r.operation_id,round(v_qty,3),round(r.quantity_kg,3);
      end if;
      v_avg:=case when v_qty>0 then v_cost/v_qty else 0 end;
      v_cogs:=round(r.quantity_kg*v_avg,2);
      v_qty:=v_qty-r.quantity_kg;
      v_cost:=greatest(0,v_cost-v_cogs);
    end if;

    update public.operation_items
    set cogs_amount=case when r.role='SHIPMENT' then v_cogs else 0 end
    where id=r.item_id;
  end loop;

  insert into public.inventory_balances(workspace_id,product_id,quantity_kg,cost_amount,avg_cost,updated_at)
  values(p_point_workspace_id,p_product_id,greatest(0,v_qty),greatest(0,v_cost),case when v_qty>0 then round(v_cost/v_qty,2) else 0 end,now())
  on conflict(workspace_id,product_id) do update set
    quantity_kg=excluded.quantity_kg,
    cost_amount=excluded.cost_amount,
    avg_cost=excluded.avg_cost,
    updated_at=now();
end;
$$;
grant execute on function public.rebuild_point_product_valuation(uuid,uuid) to authenticated;

create or replace function public.rebuild_all_point_inventory_for_operation(p_operation_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog
as $$
declare
  r record;
  v_ws uuid;
begin
  select workspace_id into v_ws from public.operations where id=p_operation_id;
  if v_ws is null or v_ws<>public.current_point_workspace_id() then raise exception 'Нет доступа к Точке'; end if;
  for r in select distinct product_id from public.operation_items where operation_id=p_operation_id loop
    perform public.rebuild_point_product_valuation(r.product_id,v_ws);
  end loop;
end;
$$;
grant execute on function public.rebuild_all_point_inventory_for_operation(uuid) to authenticated;

-- ---------- POINT OPERATION ENGINE ----------
create or replace function public.point_post_operation(
  p_type text,
  p_contractor_id uuid,
  p_operation_date date,
  p_items jsonb,
  p_note text default null,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql security definer
set search_path=public,pg_catalog
as $$
declare
  v_ws uuid:=public.current_point_workspace_id();
  v_num bigint; v_id uuid; v_existing uuid;
  v_role public.operation_role;
  v_item jsonb; v_product uuid; v_qty numeric; v_price numeric; v_waste numeric;
  v_available numeric; v_seen uuid[]:='{}'; v_closed text;
  v_note text;
begin
  perform public.ensure_point_member();
  if p_type not in ('ARRIVAL','SHIPMENT','SALE') then raise exception 'Неизвестный тип операции'; end if;
  if p_operation_date>current_date then raise exception 'Дата операции не может быть в будущем'; end if;

  select status into v_closed from public.point_evening_summaries where workspace_id=v_ws and summary_date=p_operation_date;
  if v_closed='CLOSED' then raise exception 'День уже закрыт'; end if;

  if p_idempotency_key is not null then
    select id into v_existing from public.operations where workspace_id=v_ws and idempotency_key=p_idempotency_key;
    if v_existing is not null then return v_existing; end if;
  end if;

  if p_contractor_id is null then raise exception 'Не указан контрагент'; end if;
  if not exists(select 1 from public.contractors where id=p_contractor_id and workspace_id=v_ws and archived_at is null) then raise exception 'Контрагент не найден в Точке'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Нет товаров для операции'; end if;

  v_role:=case when p_type='ARRIVAL' then 'ARRIVAL'::public.operation_role else 'SHIPMENT'::public.operation_role end;
  v_note:=case when p_type='SALE' then '[SALE] '||coalesce(p_note,'Розничная продажа') else p_note end;
  v_num:=public.next_operation_number(v_ws,p_operation_date);

  insert into public.operations(workspace_id,operation_number,operation_date,type,role,status,version,idempotency_key,contractor_id,created_by,note)
  values(v_ws,v_num,p_operation_date,case when p_type='SALE' then 'SHIPMENT'::public.operation_type else p_type::public.operation_type end,v_role,'CONFIRMED',1,p_idempotency_key,p_contractor_id,auth.uid(),v_note)
  returning id into v_id;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_product:=nullif(v_item->>'product_id','')::uuid;
    v_qty:=round((v_item->>'kg')::numeric,3);
    v_price:=round((v_item->>'price')::numeric,2);
    v_waste:=coalesce(round((v_item->>'wasteKg')::numeric,3),0);

    if v_product is null then raise exception 'Не указан товар'; end if;
    if v_qty is null or v_qty<=0 or v_price is null or v_price<0 or v_waste<0 or v_waste>v_qty then raise exception 'Некорректная строка операции'; end if;
    if v_product=any(v_seen) then raise exception 'Товар указан в операции более одного раза'; end if;
    v_seen:=array_append(v_seen,v_product);

    if not exists(select 1 from public.products where id=v_product and workspace_id=v_ws and status='ACTIVE') then raise exception 'Товар не найден в Точке'; end if;

    if p_type in ('SHIPMENT','SALE') then
      perform public.lock_product(v_ws,v_product);
      select quantity_kg into v_available from public.inventory_balances where workspace_id=v_ws and product_id=v_product for update;
      if coalesce(v_available,0)+0.000001<v_qty then raise exception 'Недостаточный остаток: доступно % кг, указано % кг',round(coalesce(v_available,0),3),round(v_qty,3); end if;
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
         v_id,auth.uid(),jsonb_build_object('type',p_type,'date',p_operation_date,'contractor_id',p_contractor_id,'items',p_items),'Операция Точки');

  return v_id;
end;
$$;
grant execute on function public.point_post_operation(text,uuid,date,jsonb,text,uuid) to authenticated;

-- Recalculate expected cash without changing the summary status.
create or replace function public.point_recalculate_evening_cash(p_summary_id uuid)
returns void
language plpgsql security definer
set search_path=public,pg_catalog
as $$
declare
  v_ws uuid:=public.current_point_workspace_id();
  v_date date;
  v_opening numeric:=0; v_brought numeric:=0; v_actual numeric; v_purchase numeric:=0; v_sales numeric:=0; v_expenses numeric:=0;
  v_expected numeric; v_variance numeric;
begin
  perform public.ensure_point_member();
  select summary_date,opening_cash,brought_cash,actual_cash into v_date,v_opening,v_brought,v_actual
  from public.point_evening_summaries
  where id=p_summary_id and workspace_id=v_ws
  for update;
  if v_date is null then raise exception 'Вечерняя сводка не найдена'; end if;

  select coalesce(sum(oi.total_amount),0) into v_purchase
  from public.operations o join public.operation_items oi on oi.operation_id=o.id
  where o.workspace_id=v_ws and o.operation_date=v_date and o.role='ARRIVAL' and coalesce(o.status,'CONFIRMED')<>'CANCELLED';

  select coalesce(sum(oi.total_amount),0) into v_sales
  from public.operations o join public.operation_items oi on oi.operation_id=o.id
  where o.workspace_id=v_ws and o.operation_date=v_date and o.note like '[SALE]%' and coalesce(o.status,'CONFIRMED')<>'CANCELLED';

  select coalesce(sum(amount),0) into v_expenses from public.point_evening_expenses where summary_id=p_summary_id and workspace_id=v_ws;

  v_expected:=greatest(0,coalesce(v_opening,0))+greatest(0,coalesce(v_brought,0))+v_sales-v_purchase-v_expenses;
  v_variance:=case when v_actual is null then null else round(v_actual-v_expected,2) end;

  update public.point_evening_summaries
  set expected_cash=round(v_expected,2),variance=v_variance,updated_at=now(),updated_by=auth.uid()
  where id=p_summary_id and workspace_id=v_ws;
end;
$$;
grant execute on function public.point_recalculate_evening_cash(uuid) to authenticated;

-- ---------- EVENING SUMMARY ----------
create or replace function public.point_save_evening_summary(p_date date,p_opening_cash numeric,p_brought_cash numeric,p_actual_cash numeric,p_note text default null)
returns uuid language plpgsql security definer set search_path=public,pg_catalog
as $$
declare
  v_ws uuid:=public.current_point_workspace_id(); v_id uuid;
  v_purchase numeric:=0; v_sales numeric:=0; v_expenses numeric:=0; v_expected numeric; v_variance numeric;
begin
  perform public.ensure_point_member();
  if p_date>current_date then raise exception 'Дата не может быть в будущем'; end if;
  if exists(select 1 from public.point_evening_summaries where workspace_id=v_ws and summary_date=p_date and status='CLOSED') then raise exception 'День уже закрыт'; end if;

  insert into public.point_evening_summaries(workspace_id,summary_date,opening_cash,brought_cash,actual_cash,note,created_by,updated_by)
  values(v_ws,p_date,greatest(0,coalesce(p_opening_cash,0)),greatest(0,coalesce(p_brought_cash,0)),p_actual_cash,p_note,auth.uid(),auth.uid())
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
  select coalesce(sum(amount),0) into v_expenses from public.point_evening_expenses where summary_id=v_id;
  select expected_cash,variance into v_expected,v_variance from public.point_evening_summaries where id=v_id;

  insert into public.audit_log(workspace_id,action,user_id,details,new_data)
  values(v_ws,'ТОЧКА: СОХРАНЕНИЕ ВЕЧЕРНЕЙ СВОДКИ',auth.uid(),'Вечерняя сводка',jsonb_build_object('summary_id',v_id,'date',p_date,'purchase_amount',v_purchase,'sales_amount',v_sales,'expenses_amount',v_expenses,'expected_cash',v_expected,'actual_cash',p_actual_cash,'variance',v_variance));

  return v_id;
end;
$$;
grant execute on function public.point_save_evening_summary(date,numeric,numeric,numeric,text) to authenticated;

create or replace function public.point_get_evening_summary(p_date date)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog
as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_data jsonb;
begin
  perform public.ensure_point_member();
  select jsonb_build_object(
    'summary',(select row_to_json(s) from public.point_evening_summaries s where s.workspace_id=v_ws and s.summary_date=p_date),
    'expenses',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'employee_id',e.employee_id,'employee_name',pe.name,'category',e.category,'comment',e.comment,'amount',e.amount,'created_at',e.created_at) order by e.created_at) from public.point_evening_expenses e left join public.point_employees pe on pe.id=e.employee_id join public.point_evening_summaries s on s.id=e.summary_id where e.workspace_id=v_ws and s.summary_date=p_date),'[]'::jsonb),
    'employees',coalesce((select jsonb_agg(jsonb_build_object('id',pe.id,'name',pe.name) order by pe.name) from public.point_employees pe where pe.workspace_id=v_ws and pe.active),'[]'::jsonb)
  ) into v_data;
  return v_data;
end;
$$;
grant execute on function public.point_get_evening_summary(date) to authenticated;

create or replace function public.point_add_evening_expense(p_summary_id uuid,p_employee_id uuid,p_category text,p_comment text,p_amount numeric)
returns uuid language plpgsql security definer set search_path=public,pg_catalog
as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_id uuid; v_status text; v_old jsonb;
begin
  perform public.ensure_point_member();
  if p_amount<=0 then raise exception 'Сумма расхода должна быть больше нуля'; end if;
  if nullif(trim(p_category),'') is null then raise exception 'Укажите категорию расхода'; end if;
  select status into v_status from public.point_evening_summaries where id=p_summary_id and workspace_id=v_ws;
  if v_status is null or v_status='CLOSED' then raise exception 'Сводка не найдена или уже закрыта'; end if;
  if p_employee_id is not null and not exists(select 1 from public.point_employees where id=p_employee_id and workspace_id=v_ws and active) then raise exception 'Сотрудник не найден'; end if;
  insert into public.point_evening_expenses(workspace_id,summary_id,employee_id,category,comment,amount,created_by)
  values(v_ws,p_summary_id,p_employee_id,trim(p_category),nullif(trim(p_comment),''),round(p_amount,2),auth.uid()) returning id into v_id;
  perform public.point_recalculate_evening_cash(p_summary_id);
  insert into public.audit_log(workspace_id,action,user_id,details,new_data)
  values(v_ws,'ТОЧКА: ДОБАВЛЕНИЕ РАСХОДА',auth.uid(),'Расход',jsonb_build_object('expense_id',v_id,'employee_id',p_employee_id,'category',trim(p_category),'comment',nullif(trim(p_comment),''),'amount',round(p_amount,2)));
  return v_id;
end;
$$;
grant execute on function public.point_add_evening_expense(uuid,uuid,text,text,numeric) to authenticated;

create or replace function public.point_remove_evening_expense(p_expense_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog
as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_summary uuid; v_old jsonb; v_status text;
begin
  perform public.ensure_point_member();
  select e.summary_id, jsonb_build_object('expense_id',e.id,'employee_id',e.employee_id,'category',e.category,'comment',e.comment,'amount',e.amount,'created_at',e.created_at), s.status
  into v_summary,v_old,v_status
  from public.point_evening_expenses e join public.point_evening_summaries s on s.id=e.summary_id
  where e.id=p_expense_id and e.workspace_id=v_ws;
  if v_summary is null then raise exception 'Расход не найден'; end if;
  if v_status='CLOSED' then raise exception 'Закрытую сводку менять нельзя'; end if;
  delete from public.point_evening_expenses where id=p_expense_id and workspace_id=v_ws;
  perform public.point_recalculate_evening_cash(v_summary);
  insert into public.audit_log(workspace_id,action,user_id,old_data,details)
  values(v_ws,'ТОЧКА: УДАЛЕНИЕ РАСХОДА',auth.uid(),v_old,'Удаление расхода');
end;
$$;
grant execute on function public.point_remove_evening_expense(uuid) to authenticated;

-- ---------- DAY CHECK / CLOSE ----------
create or replace function public.point_check_day(p_date date)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog
as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_summary record; v_errors jsonb:='[]'::jsonb; v_warnings jsonb:='[]'::jsonb; v_ops int;
begin
  perform public.ensure_point_member();
  select * into v_summary from public.point_evening_summaries where workspace_id=v_ws and summary_date=p_date;
  if v_summary.id is null then return jsonb_build_object('ok',false,'errors',jsonb_build_array('Вечерняя сводка не сохранена'),'warnings',v_warnings); end if;
  select count(*) into v_ops from public.operations where workspace_id=v_ws and operation_date=p_date and coalesce(status,'CONFIRMED')<>'CANCELLED';
  if v_summary.actual_cash is null then v_errors:=v_errors||jsonb_build_array('Не указана фактическая касса'); end if;
  if v_summary.brought_cash is null then v_errors:=v_errors||jsonb_build_array('Не указано «Принесли за день»'); end if;
  if v_ops=0 then v_warnings:=v_warnings||jsonb_build_array('За день нет складских операций'); end if;
  perform public.point_recalculate_evening_cash(v_summary.id);
  select * into v_summary from public.point_evening_summaries where id=v_summary.id;
  if v_summary.variance is not null and abs(v_summary.variance)>0.01 then v_warnings:=v_warnings||jsonb_build_array(format('Расхождение кассы: %s ₸',round(v_summary.variance,2))); end if;
  update public.point_evening_summaries set status=case when jsonb_array_length(v_errors)=0 then 'CHECKED' else 'DRAFT' end,updated_at=now(),updated_by=auth.uid() where id=v_summary.id;
  return jsonb_build_object('ok',jsonb_array_length(v_errors)=0,'errors',v_errors,'warnings',v_warnings,'operations_count',v_ops,'checked_at',now());
end;
$$;
grant execute on function public.point_check_day(date) to authenticated;

create or replace function public.point_close_day(p_date date)
returns void language plpgsql security definer set search_path=public,pg_catalog
as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_id uuid; v_status text; v_actual numeric; v_expected numeric;
begin
  perform public.ensure_point_member();
  select id,status,actual_cash,expected_cash into v_id,v_status,v_actual,v_expected
  from public.point_evening_summaries where workspace_id=v_ws and summary_date=p_date for update;
  if v_id is null then raise exception 'Сводка не найдена'; end if;
  if v_status<>'CHECKED' then raise exception 'Сначала выполните проверку дня'; end if;
  perform public.point_recalculate_evening_cash(v_id);
  select actual_cash,expected_cash into v_actual,v_expected from public.point_evening_summaries where id=v_id;
  if v_actual is null or v_expected is null then raise exception 'Сначала сохраните кассу'; end if;
  update public.point_evening_summaries set status='CLOSED',updated_at=now(),updated_by=auth.uid() where id=v_id;
  insert into public.audit_log(workspace_id,action,user_id,details,new_data)
  values(v_ws,'ТОЧКА: ЗАКРЫТИЕ ДНЯ',auth.uid(),'Закрытие вечерней сводки',jsonb_build_object('summary_id',v_id,'date',p_date,'expected_cash',v_expected,'actual_cash',v_actual,'variance',round(v_actual-v_expected,2)));
end;
$$;
grant execute on function public.point_close_day(date) to authenticated;

create or replace function public.point_reopen_day(p_date date,p_reason text)
returns void language plpgsql security definer set search_path=public,pg_catalog
as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_id uuid;
begin
  perform public.ensure_point_member();
  if public.current_user_role() not in ('admin','manager') then raise exception 'Недостаточно прав'; end if;
  select id into v_id from public.point_evening_summaries where workspace_id=v_ws and summary_date=p_date for update;
  if v_id is null then raise exception 'Сводка не найдена'; end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Укажите причину переоткрытия'; end if;
  update public.point_evening_summaries set status='DRAFT',note=concat_ws(E'\n',note,'Причина переоткрытия: '||trim(p_reason)),updated_at=now(),updated_by=auth.uid() where id=v_id;
  insert into public.audit_log(workspace_id,action,user_id,details,new_data)
  values(v_ws,'ТОЧКА: ПЕРЕОТКРЫТИЕ ДНЯ',auth.uid(),trim(p_reason),jsonb_build_object('summary_id',v_id,'date',p_date,'reason',trim(p_reason)));
end;
$$;
grant execute on function public.point_reopen_day(date,text) to authenticated;

-- ---------- STATE: ORDER FIRST, THEN LIMIT ----------
create or replace function public.point_get_state()
returns jsonb language plpgsql security definer set search_path=public,pg_catalog
as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_result jsonb;
begin
  perform public.ensure_point_member();
  select jsonb_build_object(
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'default_price',p.default_price,'status',p.status,'sort_order',coalesce(p.sort_order,0)) order by coalesce(p.sort_order,0),p.name) from public.products p where p.workspace_id=v_ws and p.status='ACTIVE'),'[]'::jsonb),
    'contractors',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'group_id',c.group_id,'group_name',g.name) order by c.name) from public.contractors c left join public.contractor_groups g on g.id=c.group_id where c.workspace_id=v_ws and c.archived_at is null),'[]'::jsonb),
    'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.name) order by g.name) from public.contractor_groups g where g.workspace_id=v_ws and g.archived_at is null),'[]'::jsonb),
    'employees',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'name',e.name) order by e.name) from public.point_employees e where e.workspace_id=v_ws and e.active),'[]'::jsonb),
    'stock',coalesce((select jsonb_agg(jsonb_build_object('product_id',p.id,'product_name',p.name,'quantity_kg',coalesce(i.quantity_kg,0),'avg_cost',coalesce(i.avg_cost,0),'inventory_value',coalesce(i.cost_amount,0)) order by p.name) from public.products p left join public.inventory_balances i on i.product_id=p.id and i.workspace_id=v_ws where p.workspace_id=v_ws and p.status='ACTIVE'),'[]'::jsonb),
    'operations',coalesce((select jsonb_agg(q.x order by (q.x->>'operation_date') desc,(q.x->>'created_at') desc,(q.x->>'id') desc) from (
      select jsonb_build_object('id',o.id,'operation_number',o.operation_number,'operation_date',o.operation_date,'type',o.type,'role',o.role,'status',coalesce(o.status,'CONFIRMED'),'contractor_id',o.contractor_id,'contractor_name',c.name,'group_name',g.name,'created_at',o.created_at,'note',o.note,'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',i.product_id,'product_name',p.name,'kg',i.quantity_kg,'price',i.unit_price,'sum',i.total_amount,'wasteKg',i.waste_kg,'cogs',i.cogs_amount) order by p.name) from public.operation_items i join public.products p on p.id=i.product_id where i.operation_id=o.id),'[]'::jsonb)) x
      from public.operations o left join public.contractors c on c.id=o.contractor_id left join public.contractor_groups g on g.id=c.group_id
      where o.workspace_id=v_ws and coalesce(o.status,'CONFIRMED')<>'CANCELLED'
      order by o.operation_date desc,o.created_at desc,o.id desc
      limit 500
    ) q),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
grant execute on function public.point_get_state() to authenticated;

-- ---------- AUDIT ----------
create or replace function public.point_get_audit_report(p_from date,p_to date,p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog
as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_result jsonb;
begin
  perform public.ensure_point_member();
  select coalesce(jsonb_agg(x order by (x->>'created_at') desc),'[]'::jsonb)
  into v_result
  from (
    select jsonb_build_object('id',a.id,'action',a.action,'operation_id',a.operation_id,'related_operation_id',a.related_operation_id,'user_id',a.user_id,'user_display_name',p.display_name,'old_data',a.old_data,'new_data',a.new_data,'details',a.details,'created_at',a.created_at) x
    from public.audit_log a left join public.profiles p on p.id=a.user_id
    where a.workspace_id=v_ws and a.created_at::date between p_from and p_to
    order by a.created_at desc,a.id desc
    limit greatest(1,least(coalesce(p_limit,200),1000))
  ) q;
  return v_result;
end;
$$;
grant execute on function public.point_get_audit_report(date,date,integer) to authenticated;

-- ---------- CANONICAL POINT -> ANGAR TRANSFER ----------
drop function if exists public.point_transfer_to_angar(jsonb,date);
drop function if exists public.point_transfer_to_angar(jsonb,date,uuid,text);
drop function if exists public.point_transfer_to_angar(uuid,numeric,text);

create or replace function public.point_transfer_to_angar(
  p_product_id uuid,
  p_quantity_kg numeric,
  p_note text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql security definer
set search_path=public,pg_catalog
as $$
declare
  v_user uuid:=auth.uid();
  v_point uuid:=public.current_point_workspace_id();
  v_angar uuid;
  v_transfer uuid:=coalesce(p_idempotency_key,gen_random_uuid());
  v_name text; v_avail numeric; v_avg numeric;
  v_angar_product uuid;
  v_point_contractor uuid; v_angar_contractor uuid;
  v_point_op uuid; v_angar_op uuid;
  v_num bigint;
  v_status text;
  v_existing_point uuid;
  v_existing_angar uuid;
begin
  perform public.ensure_point_member();
  if v_user is null then raise exception 'Пользователь не авторизован'; end if;
  if p_quantity_kg is null or p_quantity_kg<=0 then raise exception 'Количество должно быть больше нуля'; end if;

  select workspace_id into v_angar from public.profiles where id=v_user;
  if v_angar is null or v_angar=v_point then raise exception 'Не найден склад Ангар'; end if;

  if p_idempotency_key is not null then
    select point_operation_id,angar_operation_id into v_existing_point,v_existing_angar
    from public.point_transfers where transfer_group_id=p_idempotency_key limit 1;
    if v_existing_point is not null or v_existing_angar is not null then
      return jsonb_build_object('success',true,'transfer_id',p_idempotency_key,'point_operation_id',v_existing_point,'angar_operation_id',v_existing_angar,'idempotent_replay',true);
    end if;
  end if;

  select status into v_status from public.point_evening_summaries where workspace_id=v_point and summary_date=current_date;
  if v_status='CLOSED' then raise exception 'День уже закрыт'; end if;

  perform public.lock_product(v_point,p_product_id);
  select p.name,coalesce(i.quantity_kg,0),coalesce(i.avg_cost,0)
  into v_name,v_avail,v_avg
  from public.products p left join public.inventory_balances i on i.product_id=p.id and i.workspace_id=v_point
  where p.id=p_product_id and p.workspace_id=v_point and p.status='ACTIVE';
  if v_name is null then raise exception 'Товар Точки не найден'; end if;
  if v_avail+0.000001<p_quantity_kg then raise exception 'Недостаточный остаток в Точке: доступно %, требуется %',round(v_avail,3),round(p_quantity_kg,3); end if;

  select p.id into v_angar_product
  from public.products p
  where p.workspace_id=v_angar and lower(trim(p.name))=lower(trim(v_name)) and p.status='ACTIVE'
  order by p.created_at limit 1;
  if v_angar_product is null then raise exception 'Товар % отсутствует в Ангаре',v_name; end if;

  select id into v_point_contractor from public.contractors where workspace_id=v_point and lower(name)=lower('Внутреннее перемещение') and archived_at is null limit 1;
  if v_point_contractor is null then insert into public.contractors(workspace_id,name) values(v_point,'Внутреннее перемещение') returning id into v_point_contractor; end if;
  select id into v_angar_contractor from public.contractors where workspace_id=v_angar and lower(name)=lower('Внутреннее перемещение') and archived_at is null limit 1;
  if v_angar_contractor is null then insert into public.contractors(workspace_id,name) values(v_angar,'Внутреннее перемещение') returning id into v_angar_contractor; end if;

  v_num:=public.next_operation_number(v_point,current_date);
  insert into public.operations(workspace_id,operation_number,operation_date,type,role,status,version,idempotency_key,contractor_id,created_by,note)
  values(v_point,v_num,current_date,'SHIPMENT','SHIPMENT','CONFIRMED',1,v_transfer,v_point_contractor,v_user,'[TRANSFER_TO_ANGAR] transfer_id='||v_transfer::text||coalesce(' | '||p_note,''))
  returning id into v_point_op;

  insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg)
  values(v_point,v_point_op,p_product_id,round(p_quantity_kg,3),round(coalesce(v_avg,0),2),0);

  perform public.rebuild_point_product_valuation(p_product_id,v_point);

  v_num:=public.next_operation_number(v_angar,current_date);
  insert into public.operations(workspace_id,operation_number,operation_date,type,role,status,version,idempotency_key,contractor_id,created_by,note)
  values(v_angar,v_num,current_date,'ARRIVAL','ARRIVAL','CONFIRMED',1,v_transfer,v_angar_contractor,v_user,'[TRANSFER_FROM_POINT] transfer_id='||v_transfer::text||coalesce(' | '||p_note,''))
  returning id into v_angar_op;

  insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg)
  values(v_angar,v_angar_op,v_angar_product,round(p_quantity_kg,3),round(coalesce(v_avg,0),2),0);
  perform public.rebuild_product_valuation(v_angar_product,v_angar);

  update public.operations set parent_operation_id=v_point_op where id=v_angar_op;

  insert into public.point_transfers(id,transfer_group_id,point_workspace_id,angar_workspace_id,product_name,quantity_kg,unit_cost,point_operation_id,angar_operation_id,created_by)
  values(gen_random_uuid(),v_transfer,v_point,v_angar,v_name,round(p_quantity_kg,3),round(coalesce(v_avg,0),2),v_point_op,v_angar_op,v_user);

  insert into public.audit_log(workspace_id,action,operation_id,related_operation_id,user_id,new_data,details)
  values(v_point,'ТОЧКА: ПЕРЕМЕЩЕНИЕ В АНГАР',v_point_op,v_angar_op,v_user,jsonb_build_object('transfer_id',v_transfer,'product',v_name,'quantity_kg',p_quantity_kg,'unit_cost',round(coalesce(v_avg,0),2),'total_cost',round(coalesce(v_avg,0)*p_quantity_kg,2)),'Атомарное перемещение Точка → Ангар');
  insert into public.audit_log(workspace_id,action,operation_id,related_operation_id,user_id,new_data,details)
  values(v_angar,'АНГАР: ПРИХОД ИЗ ТОЧКИ',v_angar_op,v_point_op,v_user,jsonb_build_object('transfer_id',v_transfer,'product',v_name,'quantity_kg',p_quantity_kg,'unit_cost',round(coalesce(v_avg,0),2),'total_cost',round(coalesce(v_avg,0)*p_quantity_kg,2)),'Связанное перемещение из Точки');

  return jsonb_build_object('success',true,'transfer_id',v_transfer,'point_operation_id',v_point_op,'angar_operation_id',v_angar_op,'product',v_name,'quantity_kg',round(p_quantity_kg,3),'unit_cost',round(coalesce(v_avg,0),2),'total_cost',round(coalesce(v_avg,0)*p_quantity_kg,2));
end;
$$;
grant execute on function public.point_transfer_to_angar(uuid,numeric,text,uuid) to authenticated;

-- ---------- DELETE OPERATION: linked transfers are deleted as one unit ----------
create or replace function public.delete_operation(p_operation_id uuid)
returns void
language plpgsql
security definer
set search_path=public,pg_catalog
as $$
declare
  v_workspace uuid:=public.current_workspace_id();
  v_old public.operations%rowtype;
  v_point_old public.operations%rowtype;
  v_products uuid[]; v_point_products uuid[];
  v_product uuid;
  v_old_data jsonb; v_point_old_data jsonb;
  v_transfer_id uuid; v_point_operation_id uuid; v_angar_operation_id uuid; v_point_ws uuid;
begin
  perform public.ensure_manager();
  select * into v_old from public.operations where id=p_operation_id and workspace_id=v_workspace for update;
  if not found then raise exception 'Операция не найдена'; end if;
  if v_old.role='AUTO_REPLENISH' then raise exception 'Исторический автоприход доступен только для просмотра'; end if;
  if exists(select 1 from public.operations where parent_operation_id=p_operation_id and role='AUTO_REPLENISH') then raise exception 'Отгрузка связана со старым автоприходом и заблокирована для удаления'; end if;

  select id,point_operation_id,angar_operation_id,point_workspace_id
  into v_transfer_id,v_point_operation_id,v_angar_operation_id,v_point_ws
  from public.point_transfers where angar_operation_id=p_operation_id limit 1 for update;

  select array_agg(distinct product_id) into v_products from public.operation_items where operation_id=p_operation_id;
  v_old_data:=jsonb_build_object('type',v_old.type,'role',v_old.role,'status',v_old.status,'date',v_old.operation_date,'contractor_id',v_old.contractor_id,'items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',oi.product_id,'kg',oi.quantity_kg,'price',oi.unit_price,'wasteKg',oi.waste_kg,'cogs',oi.cogs_amount) order by oi.product_id),'[]'::jsonb) from public.operation_items oi where oi.operation_id=p_operation_id));

  if v_transfer_id is null then
    if v_old.type='SHIPMENT' then
      for v_product in select unnest(coalesce(v_products,'{}'::uuid[])) order by 1 loop perform public.lock_product(v_workspace,v_product); end loop;
    end if;
    insert into public.audit_log(workspace_id,action,operation_id,user_id,old_data,details) values(v_workspace,'ПОЛНОЕ УДАЛЕНИЕ ОПЕРАЦИИ',p_operation_id,auth.uid(),v_old_data,'Физическое удаление по подтверждению пользователя');
    delete from public.operation_items where operation_id=p_operation_id;
    delete from public.operations where id=p_operation_id and workspace_id=v_workspace;
    for v_product in select unnest(coalesce(v_products,'{}'::uuid[])) order by 1 loop perform public.rebuild_product_valuation(v_product,v_workspace); end loop;
    return;
  end if;

  if v_point_operation_id is null or v_angar_operation_id<>p_operation_id then raise exception 'Повреждена связь перемещения'; end if;
  select * into v_point_old from public.operations where id=v_point_operation_id for update;
  if not found then raise exception 'Связанная операция Точки не найдена'; end if;

  select array_agg(distinct product_id) into v_point_products from public.operation_items where operation_id=v_point_operation_id;
  v_point_old_data:=jsonb_build_object('type',v_point_old.type,'role',v_point_old.role,'status',v_point_old.status,'date',v_point_old.operation_date,'contractor_id',v_point_old.contractor_id,'items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',oi.product_id,'kg',oi.quantity_kg,'price',oi.unit_price,'wasteKg',oi.waste_kg,'cogs',oi.cogs_amount) order by oi.product_id),'[]'::jsonb) from public.operation_items oi where oi.operation_id=v_point_operation_id));

  if v_products is not null then for v_product in select unnest(v_products) order by 1 loop perform public.lock_product(v_workspace,v_product); end loop; end if;
  if v_point_products is not null then for v_product in select unnest(v_point_products) order by 1 loop perform public.lock_product(v_point_ws,v_product); end loop; end if;

  insert into public.audit_log(workspace_id,action,operation_id,related_operation_id,user_id,old_data,details)
  values(v_workspace,'УДАЛЕНИЕ ПЕРЕМЕЩЕНИЯ: АНГАР',p_operation_id,v_point_operation_id,auth.uid(),v_old_data,'Удаление связанного перемещения Точка → Ангар');
  insert into public.audit_log(workspace_id,action,operation_id,related_operation_id,user_id,old_data,details)
  values(v_point_ws,'УДАЛЕНИЕ ПЕРЕМЕЩЕНИЯ: ТОЧКА',v_point_operation_id,p_operation_id,auth.uid(),v_point_old_data,'Удаление связанного перемещения Точка → Ангар');

  delete from public.point_transfers where id=v_transfer_id;
  delete from public.operation_items where operation_id=v_point_operation_id;
  delete from public.operations where id=v_point_operation_id;
  delete from public.operation_items where operation_id=p_operation_id;
  delete from public.operations where id=p_operation_id and workspace_id=v_workspace;

  if v_point_products is not null then for v_product in select unnest(v_point_products) order by 1 loop perform public.rebuild_point_product_valuation(v_product,v_point_ws); end loop; end if;
  if v_products is not null then for v_product in select unnest(v_products) order by 1 loop perform public.rebuild_product_valuation(v_product,v_workspace); end loop; end if;
end;
$$;

-- Keep the canonical operation deletion signature only.
grant execute on function public.delete_operation(uuid) to authenticated;

grant execute on function public.point_get_evening_summary(date) to authenticated;
grant execute on function public.point_save_evening_summary(date,numeric,numeric,numeric,text) to authenticated;
grant execute on function public.point_add_evening_expense(uuid,uuid,text,text,numeric) to authenticated;
grant execute on function public.point_remove_evening_expense(uuid) to authenticated;
grant execute on function public.point_close_day(date) to authenticated;
grant execute on function public.point_reopen_day(date,text) to authenticated;

commit;
