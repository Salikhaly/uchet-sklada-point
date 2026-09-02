begin;

-- ==============================
-- POINT: additive module for existing Angar
-- ==============================

alter table public.profiles add column if not exists point_workspace_id uuid references public.workspaces(id) on delete set null;

-- Provision one isolated Point workspace for existing profiles.
do $$
declare
  r record;
  v_point uuid;
begin
  for r in select p.id, p.workspace_id from public.profiles p loop
    if r.id is null then continue; end if;
    if exists(select 1 from public.profiles where id=r.id and point_workspace_id is not null) then continue; end if;
    insert into public.workspaces(name) values ('Точка') returning id into v_point;
    update public.profiles set point_workspace_id=v_point where id=r.id;
    insert into public.products(workspace_id,name,default_price,status,sort_order)
      select v_point,name,default_price,status,sort_order from public.products where workspace_id=r.workspace_id;
    insert into public.contractor_groups(workspace_id,name)
      select v_point,name from public.contractor_groups where workspace_id=r.workspace_id and archived_at is null;
    insert into public.contractors(workspace_id,name,group_id)
      select v_point,c.name,pg.id
      from public.contractors c
      left join public.contractor_groups g on g.id=c.group_id
      left join public.contractor_groups pg on pg.workspace_id=v_point and lower(pg.name)=lower(g.name)
      where c.workspace_id=r.workspace_id and c.archived_at is null;
  end loop;
end $$;

create table if not exists public.point_employees(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists point_employees_workspace_name_uq on public.point_employees(workspace_id,lower(name));

create table if not exists public.point_evening_summaries(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  summary_date date not null,
  status text not null default 'DRAFT' check(status in ('DRAFT','CHECKED','CLOSED')),
  opening_cash numeric(18,2) not null default 0 check(opening_cash>=0),
  brought_cash numeric(18,2) not null default 0 check(brought_cash>=0),
  actual_cash numeric(18,2),
  expected_cash numeric(18,2),
  variance numeric(18,2),
  note text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,summary_date)
);

create table if not exists public.point_evening_expenses(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  summary_id uuid not null references public.point_evening_summaries(id) on delete cascade,
  employee_id uuid references public.point_employees(id) on delete set null,
  category text not null,
  comment text,
  amount numeric(18,2) not null check(amount>0),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists point_evening_expenses_summary_idx on public.point_evening_expenses(summary_id,created_at);

create table if not exists public.point_transfers(
  id uuid primary key default gen_random_uuid(),
  point_workspace_id uuid not null references public.workspaces(id) on delete cascade,
  angar_workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_name text not null,
  quantity_kg numeric(16,3) not null check(quantity_kg>0),
  unit_cost numeric(14,2) not null check(unit_cost>=0),
  point_operation_id uuid references public.operations(id) on delete set null,
  angar_operation_id uuid references public.operations(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists point_transfers_point_idx on public.point_transfers(point_workspace_id,created_at desc);

-- New users get a Point workspace automatically while Angar remains their original workspace.
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_workspace uuid; v_point uuid; v_name text;
begin
  v_name:=coalesce(nullif(new.raw_user_meta_data->>'display_name',''),new.email);
  insert into public.workspaces(name) values(coalesce(nullif(new.raw_user_meta_data->>'workspace_name',''),'Мой склад')) returning id into v_workspace;
  insert into public.workspaces(name) values('Точка') returning id into v_point;
  insert into public.profiles(id,workspace_id,point_workspace_id,role,display_name) values(new.id,v_workspace,v_point,'admin',v_name);
  return new;
end; $$;

-- Point helper: the current profile owns an Angar workspace and a Point workspace.
create or replace function public.current_point_workspace_id()
returns uuid language sql stable security definer set search_path=public,pg_catalog as $$
  select point_workspace_id from public.profiles where id=auth.uid();
$$;

create or replace function public.ensure_point_member()
returns void language plpgsql stable security definer set search_path=public,pg_catalog as $$
begin
  if public.current_point_workspace_id() is null then raise exception 'Точка не настроена'; end if;
end; $$;

-- Use the existing product/contractor operation engine schema, but keep Point access behind point RPCs.
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
      from operations o join contractors c on c.id=o.contractor_id left join contractor_groups g on g.id=c.group_id where o.workspace_id=v_ws and coalesce(o.status,'CONFIRMED')<>'CANCELLED' limit 500) q),'[]'::jsonb)
  ) into v_result;
  return v_result;
end; $$;

create or replace function public.point_upsert_product(p_name text,p_price numeric)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_id uuid;
begin
  perform public.ensure_point_member();
  if public.current_user_role() not in ('admin','manager') then raise exception 'Недостаточно прав'; end if;
  select id into v_id from products where workspace_id=v_ws and lower(name)=lower(trim(p_name));
  if v_id is null then insert into products(workspace_id,name,default_price,status) values(v_ws,trim(p_name),greatest(0,p_price),'ACTIVE') returning id into v_id;
  else update products set default_price=greatest(0,p_price),status='ACTIVE' where id=v_id; end if;
  return v_id;
end; $$;

create or replace function public.point_upsert_employee(p_name text)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_id uuid;
begin
  perform public.ensure_point_member();
  if public.current_user_role() not in ('admin','manager') then raise exception 'Недостаточно прав'; end if;
  insert into point_employees(workspace_id,name) values(v_ws,trim(p_name)) on conflict(workspace_id,lower(name)) do update set active=true returning id into v_id;
  return v_id;
end; $$;

create or replace function public.point_post_operation(p_type text,p_contractor_id uuid,p_operation_date date,p_items jsonb,p_note text default null,p_idempotency_key uuid default null)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_ws uuid:=public.current_point_workspace_id(); v_num bigint; v_id uuid; v_role public.operation_role; v_item jsonb; v_product uuid; v_qty numeric; v_price numeric; v_waste numeric; v_available numeric;
begin
  perform public.ensure_point_member();
  if p_type not in ('ARRIVAL','SHIPMENT','SALE') then raise exception 'Неизвестный тип операции'; end if;
  if p_idempotency_key is not null then select id into v_idem from operations where workspace_id=v_ws and idempotency_key=p_idempotency_key; if v_idem is not null then return v_idem; end if; end if;
  if p_operation_date>current_date then raise exception 'Дата не может быть в будущем'; end if;
  if p_type in ('SHIPMENT','SALE') and p_contractor_id is null then raise exception 'Нужен получатель'; end if;
  v_role:=case p_type when 'ARRIVAL' then 'ARRIVAL'::public.operation_role when 'SHIPMENT' then 'SHIPMENT'::public.operation_role else 'SHIPMENT'::public.operation_role end;
  if p_type='SALE' then
    v_role:='SHIPMENT'::public.operation_role;
  end if;
  v_num:=public.next_operation_number(v_ws,p_operation_date);
  insert into operations(workspace_id,operation_number,operation_date,type,role,status,version,idempotency_key,contractor_id,created_by,note) values(v_ws,v_num,p_operation_date,case when p_type='SALE' then 'SHIPMENT'::public.operation_type else p_type::public.operation_type end,v_role,'CONFIRMED',1,p_idempotency_key,p_contractor_id,auth.uid(),case when p_type='SALE' then '[SALE] '||coalesce(p_note,'') else p_note end) returning id into v_id;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_product:=(v_item->>'product_id')::uuid; v_qty:=round((v_item->>'kg')::numeric,3); v_price:=round((v_item->>'price')::numeric,2); v_waste:=coalesce(round((v_item->>'wasteKg')::numeric,3),0);
    if not exists(select 1 from products where id=v_product and workspace_id=v_ws and status='ACTIVE') then raise exception 'Товар не найден'; end if;
    if v_qty<=0 or v_price<0 or v_waste<0 or v_waste>v_qty then raise exception 'Некорректная строка операции'; end if;
    if p_type in ('SHIPMENT','SALE') then
      select quantity_kg into v_available from inventory_balances where workspace_id=v_ws and product_id=v_product;
      if coalesce(v_available,0)+0.000001 < v_qty then raise exception 'Недостаточный остаток: доступно % кг, указано % кг',round(coalesce(v_available,0),3),round(v_qty,3); end if;
    end if;
    insert into operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg) values(v_ws,v_id,v_product,v_qty,v_price,v_waste);
  end loop;
  if not exists(select 1 from operation_items where operation_id=v_id) then raise exception 'Добавьте товар'; end if;
  perform public.rebuild_all_point_inventory_for_operation(v_id);
  insert into audit_log(workspace_id,action,operation_id,user_id,new_data,details) values(v_ws,case when p_type='ARRIVAL' then 'ТОЧКА: СОЗДАНИЕ ПРИХОДА' when p_type='SALE' then 'ТОЧКА: СОЗДАНИЕ ПРОДАЖИ' else 'ТОЧКА: СОЗДАНИЕ ОТГРУЗКИ' end,v_id,auth.uid(),jsonb_build_object('type',p_type,'date',p_operation_date,'contractor_id',p_contractor_id,'items',p_items),'Операция Точки');
  return v_id;
end; $$;

create or replace function public.rebuild_all_point_inventory_for_operation(p_operation_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare r record; v_ws uuid;
begin
  select workspace_id into v_ws from operations where id=p_operation_id;
  if v_ws is null or v_ws<>public.current_point_workspace_id() then raise exception 'Нет доступа'; end if;
  for r in select distinct product_id from operation_items where operation_id=p_operation_id loop
    perform public.rebuild_product_valuation(r.product_id,v_ws);
  end loop;
end; $$;

-- Create a retail system contractor in each Point workspace.
do $$
declare r record;
begin
  for r in select point_workspace_id ws from profiles where point_workspace_id is not null loop
    insert into contractors(workspace_id,name) values(r.ws,'Розничный покупатель') on conflict(workspace_id,lower(name)) do nothing;
    insert into contractors(workspace_id,name) values(r.ws,'Население') on conflict(workspace_id,lower(name)) do nothing;
  end loop;
end $$;

create or replace function public.point_save_evening_summary(
  p_date date,p_opening_cash numeric,p_brought_cash numeric,p_actual_cash numeric,p_note text default null)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_id uuid; v_purchase numeric; v_expenses numeric; v_expected numeric; v_variance numeric;
begin
  perform public.ensure_point_member();
  if p_date>current_date then raise exception 'Дата не может быть в будущем'; end if;
  if exists(select 1 from point_evening_summaries where workspace_id=v_ws and summary_date=p_date and status='CLOSED') then raise exception 'День уже закрыт'; end if;
  select coalesce(sum(oi.total_amount),0) into v_purchase from operations o join operation_items oi on oi.operation_id=o.id where o.workspace_id=v_ws and o.operation_date=p_date and o.type='ARRIVAL' and o.role='ARRIVAL' and coalesce(o.status,'CONFIRMED')<>'CANCELLED';
  insert into point_evening_summaries(workspace_id,summary_date,opening_cash,brought_cash,actual_cash,note,created_by,updated_by)
  values(v_ws,p_date,greatest(0,p_opening_cash),greatest(0,p_brought_cash),p_actual_cash,p_note,auth.uid(),auth.uid())
  on conflict(workspace_id,summary_date) do update set opening_cash=excluded.opening_cash,brought_cash=excluded.brought_cash,actual_cash=excluded.actual_cash,note=excluded.note,updated_by=auth.uid(),updated_at=now()
  returning id into v_id;
  select coalesce(sum(amount),0) into v_expenses from point_evening_expenses where summary_id=v_id;
  v_expected:=greatest(0,p_opening_cash)+greatest(0,p_brought_cash)-v_purchase-v_expenses;
  v_variance:=case when p_actual_cash is null then null else p_actual_cash-v_expected end;
  update point_evening_summaries set expected_cash=v_expected,variance=v_variance,updated_at=now(),updated_by=auth.uid() where id=v_id;
  insert into audit_log(workspace_id,action,user_id,details,new_data) values(v_ws,'ТОЧКА: СОХРАНЕНИЕ ВЕЧЕРНЕЙ СВОДКИ',auth.uid(),'Вечерняя сводка',jsonb_build_object('summary_id',v_id,'date',p_date,'purchase_amount',v_purchase,'expenses_amount',v_expenses,'expected_cash',v_expected,'actual_cash',p_actual_cash,'variance',v_variance));
  return v_id;
end; $$;

create or replace function public.point_add_evening_expense(p_summary_id uuid,p_employee_id uuid,p_category text,p_comment text,p_amount numeric)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_id uuid;
begin
  perform public.ensure_point_member();
  if p_amount<=0 then raise exception 'Сумма расхода должна быть больше нуля'; end if;
  if not exists(select 1 from point_evening_summaries where id=p_summary_id and workspace_id=v_ws and status<>'CLOSED') then raise exception 'Сводка не найдена или уже закрыта'; end if;
  if p_employee_id is not null and not exists(select 1 from point_employees where id=p_employee_id and workspace_id=v_ws and active) then raise exception 'Сотрудник не найден'; end if;
  insert into point_evening_expenses(workspace_id,summary_id,employee_id,category,comment,amount,created_by) values(v_ws,p_summary_id,p_employee_id,trim(p_category),nullif(trim(p_comment),''),p_amount,auth.uid()) returning id into v_id;
  return v_id;
end; $$;

create or replace function public.point_remove_evening_expense(p_expense_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_summary uuid;
begin
  perform public.ensure_point_member();
  select summary_id into v_summary from point_evening_expenses where id=p_expense_id and workspace_id=v_ws;
  if v_summary is null then raise exception 'Расход не найден'; end if;
  if exists(select 1 from point_evening_summaries where id=v_summary and status='CLOSED') then raise exception 'Закрытую сводку менять нельзя'; end if;
  delete from point_evening_expenses where id=p_expense_id and workspace_id=v_ws;
end; $$;

create or replace function public.point_check_day(p_date date)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_summary record; v_errors jsonb:='[]'::jsonb; v_warnings jsonb:='[]'::jsonb; v_purchase numeric; v_expense numeric; v_ops integer;
begin
  perform public.ensure_point_member();
  select * into v_summary from point_evening_summaries where workspace_id=v_ws and summary_date=p_date;
  if v_summary.id is null then v_errors:=v_errors||jsonb_build_array('Вечерняя сводка не сохранена'); return jsonb_build_object('ok',false,'errors',v_errors,'warnings',v_warnings); end if;
  select count(*) into v_ops from operations where workspace_id=v_ws and operation_date=p_date and coalesce(status,'CONFIRMED')<>'CANCELLED';
  select coalesce(sum(oi.total_amount),0) into v_purchase from operations o join operation_items oi on oi.operation_id=o.id where o.workspace_id=v_ws and o.operation_date=p_date and o.type='ARRIVAL' and o.role='ARRIVAL' and coalesce(o.status,'CONFIRMED')<>'CANCELLED';
  select coalesce(sum(amount),0) into v_expense from point_evening_expenses where summary_id=v_summary.id;
  if v_summary.actual_cash is null then v_errors:=v_errors||jsonb_build_array('Не указана фактическая касса'); end if;
  if v_summary.brought_cash is null then v_errors:=v_errors||jsonb_build_array('Не указано «Принесли за день»'); end if;
  if v_summary.variance is not null and abs(v_summary.variance)>0.01 then v_warnings:=v_warnings||jsonb_build_array(format('Расхождение кассы: %s ₸',round(v_summary.variance,2))); end if;
  if v_ops=0 then v_warnings:=v_warnings||jsonb_build_array('За день нет складских операций'); end if;
  update point_evening_summaries set status=case when jsonb_array_length(v_errors)=0 then 'CHECKED' else 'DRAFT' end,updated_at=now(),updated_by=auth.uid() where id=v_summary.id;
  return jsonb_build_object('ok',jsonb_array_length(v_errors)=0,'errors',v_errors,'warnings',v_warnings,'purchase_amount',v_purchase,'expense_amount',v_expense,'operations_count',v_ops,'checked_at',now());
end; $$;

create or replace function public.point_close_day(p_date date)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_id uuid; v_status text;
begin
  perform public.ensure_point_member();
  select id,status into v_id,v_status from point_evening_summaries where workspace_id=v_ws and summary_date=p_date;
  if v_id is null then raise exception 'Сводка не найдена'; end if;
  if v_status<>'CHECKED' then raise exception 'Сначала выполните проверку дня'; end if;
  update point_evening_summaries set status='CLOSED',updated_at=now(),updated_by=auth.uid() where id=v_id;
  insert into audit_log(workspace_id,action,user_id,details,new_data) values(v_ws,'ТОЧКА: ЗАКРЫТИЕ ДНЯ',auth.uid(),'Закрытие вечерней сводки',jsonb_build_object('summary_id',v_id,'date',p_date));
end; $$;

create or replace function public.point_reopen_day(p_date date,p_reason text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_id uuid;
begin
  perform public.ensure_point_member();
  if public.current_user_role() not in ('admin','manager') then raise exception 'Недостаточно прав'; end if;
  select id into v_id from point_evening_summaries where workspace_id=v_ws and summary_date=p_date for update;
  if v_id is null then raise exception 'Сводка не найдена'; end if;
  update point_evening_summaries set status='DRAFT',note=concat_ws(E'\n',note,'Причина переоткрытия: '||trim(p_reason)),updated_at=now(),updated_by=auth.uid() where id=v_id;
  insert into audit_log(workspace_id,action,user_id,details,new_data) values(v_ws,'ТОЧКА: ПЕРЕОТКРЫТИЕ ДНЯ',auth.uid(),trim(p_reason),jsonb_build_object('summary_id',v_id,'date',p_date));
end; $$;

create or replace function public.point_get_evening_summary(p_date date)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_id uuid; v_data jsonb;
begin
  perform public.ensure_point_member();
  insert into point_evening_summaries(workspace_id,summary_date) values(v_ws,p_date) on conflict(workspace_id,summary_date) do nothing;
  select id into v_id from point_evening_summaries where workspace_id=v_ws and summary_date=p_date;
  select jsonb_build_object(
    'summary', (select row_to_json(s) from point_evening_summaries s where s.id=v_id),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'employee_id',e.employee_id,'employee_name',pe.name,'category',e.category,'comment',e.comment,'amount',e.amount,'created_at',e.created_at) order by e.created_at) from point_evening_expenses e left join point_employees pe on pe.id=e.employee_id where e.summary_id=v_id),'[]'::jsonb),
    'employees', coalesce((select jsonb_agg(jsonb_build_object('id',pe.id,'name',pe.name) order by pe.name) from point_employees pe where pe.workspace_id=v_ws and pe.active),'[]'::jsonb)
  ) into v_data;
  return v_data;
end; $$;

create or replace function public.point_get_report(p_from date,p_to date)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_point_workspace_id(); v_result jsonb;
begin
  perform public.ensure_point_member();
  select jsonb_build_object(
    'totals',jsonb_build_object(
      'purchase_kg',coalesce(sum(case when o.role='ARRIVAL' then oi.quantity_kg else 0 end),0),
      'purchase_amount',coalesce(sum(case when o.role='ARRIVAL' then oi.total_amount else 0 end),0),
      'shipment_kg',coalesce(sum(case when o.role='SHIPMENT' and o.note not like '[SALE]%' and o.note not like '[TRANSFER_TO_ANGAR]%' then oi.quantity_kg else 0 end),0),
      'shipment_amount',coalesce(sum(case when o.role='SHIPMENT' and o.note not like '[SALE]%' and o.note not like '[TRANSFER_TO_ANGAR]%' then oi.total_amount else 0 end),0),
      'sale_kg',coalesce(sum(case when o.note like '[SALE]%' then oi.quantity_kg else 0 end),0),
      'sale_amount',coalesce(sum(case when o.note like '[SALE]%' then oi.total_amount else 0 end),0),
      'transfer_kg',coalesce(sum(case when o.note like '[TRANSFER_TO_ANGAR]%' then oi.quantity_kg else 0 end),0),
      'cogs',coalesce(sum(case when o.role='SHIPMENT' and o.note not like '[SALE]%' and o.note not like '[TRANSFER_TO_ANGAR]%' then oi.cogs_amount else 0 end),0),
      'sale_cogs',coalesce(sum(case when o.note like '[SALE]%' then oi.cogs_amount else 0 end),0)
    ),
    'products',coalesce((select jsonb_agg(x order by (x->>'shipment_amount')::numeric desc) from (select jsonb_build_object('name',p.name,'stock_kg',coalesce(i.quantity_kg,0),'purchase_kg',coalesce(sum(case when o.role='ARRIVAL' then oi.quantity_kg else 0 end),0),'shipment_kg',coalesce(sum(case when o.role='SHIPMENT' and o.note not like '[SALE]%' and o.note not like '[TRANSFER_TO_ANGAR]%' then oi.quantity_kg else 0 end),0),'sale_kg',coalesce(sum(case when o.note like '[SALE]%' then oi.quantity_kg else 0 end),0),'purchase_amount',coalesce(sum(case when o.role='ARRIVAL' then oi.total_amount else 0 end),0),'shipment_amount',coalesce(sum(case when o.role='SHIPMENT' and o.note not like '[SALE]%' and o.note not like '[TRANSFER_TO_ANGAR]%' then oi.total_amount else 0 end),0),'sale_amount',coalesce(sum(case when o.note like '[SALE]%' then oi.total_amount else 0 end),0)) x from products p left join inventory_balances i on i.product_id=p.id and i.workspace_id=v_ws left join operation_items oi on oi.product_id=p.id and oi.workspace_id=v_ws left join operations o on o.id=oi.operation_id and o.workspace_id=v_ws and o.operation_date between p_from and p_to where p.workspace_id=v_ws group by p.id,p.name,i.quantity_kg) q),'[]'::jsonb),
    'employees',coalesce((select jsonb_agg(x order by (x->>'amount')::numeric desc) from (select jsonb_build_object('employee_id',pe.id,'employee_name',pe.name,'amount',coalesce(sum(e.amount),0)) x from point_employees pe left join point_evening_expenses e on e.employee_id=pe.id and e.workspace_id=v_ws left join point_evening_summaries s on s.id=e.summary_id and s.summary_date between p_from and p_to where pe.workspace_id=v_ws group by pe.id,pe.name) q),'[]'::jsonb),
    'categories',coalesce((select jsonb_agg(x order by (x->>'amount')::numeric desc) from (select jsonb_build_object('category',e.category,'amount',sum(e.amount)) x from point_evening_expenses e join point_evening_summaries s on s.id=e.summary_id where e.workspace_id=v_ws and s.summary_date between p_from and p_to group by e.category) q),'[]'::jsonb)
  ) into v_result
  from operations o join operation_items oi on oi.operation_id=o.id where o.workspace_id=v_ws and o.operation_date between p_from and p_to;
  return coalesce(v_result,'{}'::jsonb);
end; $$;

-- Transfer Point -> Angar as one DB transaction.
create or replace function public.point_transfer_to_angar(p_items jsonb,p_date date)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  v_point uuid:=public.current_point_workspace_id(); v_angar uuid; v_transfer uuid:=gen_random_uuid(); v_item jsonb; v_ppid uuid; v_apid uuid; v_name text; v_qty numeric; v_cost numeric; v_avail numeric; v_avg numeric; v_point_op uuid; v_angar_op uuid; v_num bigint; v_count int:=0; v_out_items jsonb:='[]'::jsonb; v_in_items jsonb:='[]'::jsonb;
begin
  perform public.ensure_point_member();
  if exists(select 1 from point_evening_summaries where workspace_id=v_point and summary_date=p_date and status='CLOSED') then raise exception 'День уже закрыт'; end if;
  select workspace_id into v_angar from profiles where id=auth.uid();
  if v_angar is null or v_angar=v_point then raise exception 'Не найден склад Ангар'; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_ppid:=(v_item->>'product_id')::uuid; v_qty:=round((v_item->>'kg')::numeric,3);
    select p.name,coalesce(i.quantity_kg,0),coalesce(i.avg_cost,0) into v_name,v_avail,v_avg from products p left join inventory_balances i on i.product_id=p.id and i.workspace_id=v_point where p.id=v_ppid and p.workspace_id=v_point;
    if v_name is null then raise exception 'Товар Точки не найден'; end if;
    if v_qty<=0 then raise exception 'Количество должно быть больше нуля'; end if;
    if v_avail+0.000001<v_qty then raise exception 'Недостаточный остаток %: доступно % кг, указано % кг',v_name,round(v_avail,3),round(v_qty,3); end if;
    select id into v_apid from products where workspace_id=v_angar and lower(name)=lower(v_name) limit 1;
    if v_apid is null then raise exception 'Товар % отсутствует в Ангаре',v_name; end if;
    v_out_items:=v_out_items||jsonb_build_array(jsonb_build_object('product_id',v_ppid,'kg',v_qty,'price',v_avg,'wasteKg',0));
    v_in_items:=v_in_items||jsonb_build_array(jsonb_build_object('product_id',v_apid,'kg',v_qty,'price',v_avg,'wasteKg',0));
    insert into point_transfers(id,point_workspace_id,angar_workspace_id,product_name,quantity_kg,unit_cost,created_by) values(v_transfer,v_point,v_angar,v_name,v_qty,v_avg,auth.uid());
    v_count:=v_count+1;
  end loop;
  if v_count=0 then raise exception 'Добавьте товар для перемещения'; end if;

  -- Create source movement in Point directly.
  v_num:=public.next_operation_number(v_point,p_date);
  select id into v_point_op from contractors where workspace_id=v_point and lower(name)=lower('Внутреннее перемещение') limit 1;
  if v_point_op is null then insert into contractors(workspace_id,name) values(v_point,'Внутреннее перемещение') returning id into v_point_op; end if;
  insert into operations(workspace_id,operation_number,operation_date,type,role,contractor_id,created_by,note) values(v_point,v_num,p_date,'SHIPMENT','SHIPMENT',v_point_op,auth.uid(),'[TRANSFER_TO_ANGAR] transfer_id='||v_transfer::text) returning id into v_point_op;
  -- insert source items and remove stock by valuation using original point products
  for v_item in select * from jsonb_array_elements(v_out_items) loop
    insert into operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg) values(v_point,v_point_op,(v_item->>'product_id')::uuid,(v_item->>'kg')::numeric,(v_item->>'price')::numeric,0);
  end loop;
  perform public.rebuild_all_point_inventory_for_operation(v_point_op);

  -- Create destination arrival in Angar with source average cost.
  v_num:=public.next_operation_number(v_angar,p_date);
  select id into v_angar_op from contractors where workspace_id=v_angar and lower(name)=lower('Внутреннее перемещение') limit 1;
  if v_angar_op is null then insert into contractors(workspace_id,name) values(v_angar,'Внутреннее перемещение') returning id into v_angar_op; end if;
  insert into operations(workspace_id,operation_number,operation_date,type,role,contractor_id,created_by,note) values(v_angar,v_num,p_date,'ARRIVAL','ARRIVAL',v_angar_op,auth.uid(),'[TRANSFER_FROM_POINT] transfer_id='||v_transfer::text) returning id into v_angar_op;
  for v_item in select * from jsonb_array_elements(v_in_items) loop
    insert into operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg) values(v_angar,v_angar_op,(v_item->>'product_id')::uuid,(v_item->>'kg')::numeric,(v_item->>'price')::numeric,0);
  end loop;
  for v_item in select * from jsonb_array_elements(v_in_items) loop
    perform public.rebuild_product_valuation((v_item->>'product_id')::uuid,v_angar);
  end loop;

  update point_transfers set point_operation_id=v_point_op,angar_operation_id=v_angar_op where id=v_transfer;
  insert into audit_log(workspace_id,action,operation_id,related_operation_id,user_id,details,new_data) values(v_point,'ТОЧКА: ПЕРЕМЕЩЕНИЕ В АНГАР',v_point_op,v_angar_op,auth.uid(),'Атомарное перемещение',jsonb_build_object('transfer_id',v_transfer,'date',p_date,'items',p_items));
  insert into audit_log(workspace_id,action,operation_id,related_operation_id,user_id,details,new_data) values(v_angar,'АНГАР: ПРИХОД ИЗ ТОЧКИ',v_angar_op,v_point_op,auth.uid(),'Связанное перемещение из Точки',jsonb_build_object('transfer_id',v_transfer));
  return jsonb_build_object('transfer_id',v_transfer,'point_operation_id',v_point_op,'angar_operation_id',v_angar_op);
end; $$;

-- RLS: Point tables are isolated from Angar by point_workspace_id().
alter table public.point_employees enable row level security;
alter table public.point_evening_summaries enable row level security;
alter table public.point_evening_expenses enable row level security;
alter table public.point_transfers enable row level security;

drop policy if exists point_employees_select on public.point_employees;
create policy point_employees_select on public.point_employees for select to authenticated using(workspace_id=public.current_point_workspace_id());
drop policy if exists point_summary_select on public.point_evening_summaries;
create policy point_summary_select on public.point_evening_summaries for select to authenticated using(workspace_id=public.current_point_workspace_id());
drop policy if exists point_expenses_select on public.point_evening_expenses;
create policy point_expenses_select on public.point_evening_expenses for select to authenticated using(workspace_id=public.current_point_workspace_id());
drop policy if exists point_transfers_select on public.point_transfers;
create policy point_transfers_select on public.point_transfers for select to authenticated using(point_workspace_id=public.current_point_workspace_id());

revoke all on table public.point_employees from authenticated,anon;
revoke all on table public.point_evening_summaries from authenticated,anon;
revoke all on table public.point_evening_expenses from authenticated,anon;
revoke all on table public.point_transfers from authenticated,anon;

grant select on public.point_employees,public.point_evening_summaries,public.point_evening_expenses,public.point_transfers to authenticated;

grant execute on function public.current_point_workspace_id() to authenticated;
grant execute on function public.point_get_state() to authenticated;
grant execute on function public.point_upsert_product(text,numeric) to authenticated;
grant execute on function public.point_upsert_employee(text) to authenticated;
grant execute on function public.point_post_operation(text,uuid,date,jsonb,text,uuid) to authenticated;
grant execute on function public.point_save_evening_summary(date,numeric,numeric,numeric,text) to authenticated;
grant execute on function public.point_add_evening_expense(uuid,uuid,text,text,numeric) to authenticated;
grant execute on function public.point_remove_evening_expense(uuid) to authenticated;
grant execute on function public.point_check_day(date) to authenticated;
grant execute on function public.point_close_day(date) to authenticated;
grant execute on function public.point_reopen_day(date,text) to authenticated;
grant execute on function public.point_get_evening_summary(date) to authenticated;
grant execute on function public.point_get_report(date,date) to authenticated;
grant execute on function public.point_transfer_to_angar(jsonb,date) to authenticated;

commit;
