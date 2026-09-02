begin;
create extension if not exists pgcrypto;

create type public.operation_type as enum ('ARRIVAL','SHIPMENT');
create type public.operation_role as enum ('ARRIVAL','SHIPMENT','AUTO_REPLENISH');
create type public.product_status as enum ('ACTIVE','ARCHIVED');
create type public.member_role as enum ('admin','manager','operator','viewer');

create table public.workspaces(id uuid primary key default gen_random_uuid(), name text not null, created_at timestamptz not null default now());
create table public.profiles(id uuid primary key references auth.users(id) on delete cascade, workspace_id uuid not null references public.workspaces(id) on delete cascade, role public.member_role not null default 'operator', display_name text, created_at timestamptz not null default now());

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_workspace uuid;
begin
 insert into public.workspaces(name) values(coalesce(nullif(new.raw_user_meta_data->>'workspace_name',''),'Мой склад')) returning id into v_workspace;
 insert into public.profiles(id,workspace_id,role,display_name) values(new.id,v_workspace,'admin',coalesce(nullif(new.raw_user_meta_data->>'display_name',''),new.email));
 return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.current_workspace_id() returns uuid language sql stable security definer set search_path=public,pg_catalog as $$ select workspace_id from public.profiles where id=auth.uid(); $$;
create or replace function public.current_user_role() returns public.member_role language sql stable security definer set search_path=public,pg_catalog as $$ select role from public.profiles where id=auth.uid(); $$;
create or replace function public.ensure_member(p_workspace_id uuid) returns void language plpgsql stable security definer set search_path=public,pg_catalog as $$ begin if p_workspace_id is null or p_workspace_id <> public.current_workspace_id() then raise exception 'Нет доступа к складу'; end if; end; $$;
create or replace function public.ensure_manager() returns void language plpgsql stable security definer set search_path=public,pg_catalog as $$ begin if public.current_user_role() not in ('admin','manager') then raise exception 'Недостаточно прав'; end if; end; $$;

create table public.products(id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,name text not null,default_price numeric(14,2) not null default 0 check(default_price>=0),status public.product_status not null default 'ACTIVE',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),legacy_product_id text);
create unique index products_workspace_name_uq on public.products(workspace_id,lower(name));
create table public.price_history(id bigint generated always as identity primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,product_id uuid not null references public.products(id) on delete cascade,old_price numeric(14,2) not null default 0,new_price numeric(14,2) not null default 0,source text not null default 'MANUAL',changed_by uuid references auth.users(id),changed_at timestamptz not null default now());

create table public.contractor_groups(id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,name text not null,created_at timestamptz not null default now());
create unique index contractor_groups_workspace_name_uq on public.contractor_groups(workspace_id,lower(name));
create table public.contractors(id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,name text not null,group_id uuid references public.contractor_groups(id) on delete set null,created_at timestamptz not null default now());
create unique index contractors_workspace_name_uq on public.contractors(workspace_id,lower(name));

create table public.operations(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,
 legacy_operation_id text,legacy_parent_operation_id text,operation_number bigint not null,operation_date date not null,type public.operation_type not null,role public.operation_role not null,
 contractor_id uuid not null references public.contractors(id),parent_operation_id uuid references public.operations(id) on delete set null,
 created_by uuid references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),note text);
create unique index operations_workspace_legacy_id_uq on public.operations(workspace_id,legacy_operation_id) where legacy_operation_id is not null;
create unique index operations_workspace_date_number_uq on public.operations(workspace_id,operation_date,operation_number);
create index operations_workspace_date_idx on public.operations(workspace_id,operation_date,created_at,id);
create index operations_workspace_contractor_idx on public.operations(workspace_id,contractor_id,operation_date desc);
create index operations_parent_idx on public.operations(parent_operation_id);

create table public.operation_items(id bigint generated always as identity primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,operation_id uuid not null references public.operations(id) on delete cascade,product_id uuid not null references public.products(id),quantity_kg numeric(16,3) not null check(quantity_kg>0),unit_price numeric(14,2) not null check(unit_price>=0),total_amount numeric(18,2) generated always as (round(quantity_kg*unit_price,2)) stored,waste_kg numeric(16,3) not null default 0 check(waste_kg>=0 and waste_kg<=quantity_kg),cogs_amount numeric(18,2) not null default 0 check(cogs_amount>=0),created_at timestamptz not null default now(),unique(operation_id,product_id));
create index operation_items_workspace_product_idx on public.operation_items(workspace_id,product_id);
create index operation_items_operation_idx on public.operation_items(operation_id);

create table public.inventory_balances(workspace_id uuid not null references public.workspaces(id) on delete cascade,product_id uuid not null references public.products(id) on delete cascade,quantity_kg numeric(16,3) not null default 0 check(quantity_kg>=0),cost_amount numeric(18,2) not null default 0 check(cost_amount>=0),avg_cost numeric(14,2) generated always as(case when quantity_kg>0 then round(cost_amount/quantity_kg,2) else 0 end) stored,updated_at timestamptz not null default now(),primary key(workspace_id,product_id));
create table public.audit_log(id bigint generated always as identity primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,action text not null,operation_id uuid,related_operation_id uuid,user_id uuid references auth.users(id),old_data jsonb,new_data jsonb,details text,created_at timestamptz not null default now());
create index audit_log_workspace_created_idx on public.audit_log(workspace_id,created_at desc);
create index audit_log_operation_idx on public.audit_log(operation_id,created_at desc);

create or replace function public.next_operation_number(p_workspace_id uuid,p_date date) returns bigint language plpgsql security definer set search_path=public,pg_catalog as $$ declare v_num bigint; begin perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||'|'||p_date::text,0)); select coalesce(max(operation_number),0)+1 into v_num from public.operations where workspace_id=p_workspace_id and operation_date=p_date; return v_num; end; $$;

create or replace function public.lock_product(p_workspace_id uuid,p_product_id uuid) returns void language sql security definer as $$ select pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||'|'||p_product_id::text,17)); $$;

create or replace function public.rebuild_product_valuation(p_product_id uuid,p_workspace_id uuid) returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare r record; v_qty numeric(16,3):=0; v_cost numeric(18,2):=0; v_avg numeric(18,8):=0; v_cogs numeric(18,2):=0;
begin perform public.ensure_member(p_workspace_id); perform public.lock_product(p_workspace_id,p_product_id);
 for r in select o.id operation_id,o.type,o.role,o.operation_date,o.created_at,i.id item_id,i.quantity_kg,i.unit_price from public.operations o join public.operation_items i on i.operation_id=o.id where o.workspace_id=p_workspace_id and i.workspace_id=p_workspace_id and i.product_id=p_product_id order by o.operation_date,o.created_at,o.id loop
  if r.role='AUTO_REPLENISH' or r.type='ARRIVAL' then
    v_qty:=v_qty+r.quantity_kg; v_cost:=v_cost+round(r.quantity_kg*r.unit_price,2); v_cogs:=0;
  else
    if v_qty+0.000001 < r.quantity_kg then raise exception 'Недостаточный остаток товара % на операции %: доступно %, требуется %',p_product_id,r.operation_id,round(v_qty,3),round(r.quantity_kg,3); end if;
    if v_qty>0 then v_avg:=v_cost/v_qty; else v_avg:=0; end if;
    v_cogs:=round(r.quantity_kg*v_avg,2); v_qty:=v_qty-r.quantity_kg; v_cost:=greatest(0,v_cost-v_cogs);
  end if;
  update public.operation_items set cogs_amount=case when r.role='SHIPMENT' then v_cogs else 0 end where id=r.item_id;
 end loop;
 insert into public.inventory_balances(workspace_id,product_id,quantity_kg,cost_amount,updated_at) values(p_workspace_id,p_product_id,greatest(0,v_qty),greatest(0,v_cost),now()) on conflict(workspace_id,product_id) do update set quantity_kg=excluded.quantity_kg,cost_amount=excluded.cost_amount,updated_at=now();
end; $$;

create or replace function public.post_operation(p_type public.operation_type,p_contractor_id uuid,p_operation_date date,p_items jsonb,p_note text default null) returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_workspace uuid:=public.current_workspace_id(); v_id uuid; v_num bigint; v_item jsonb; v_product uuid; v_seen uuid[]:='{}'; v_name text; v_qty numeric; v_price numeric; v_waste numeric; v_role public.operation_role;
begin
 if v_workspace is null then raise exception 'Пользователь не авторизован'; end if; if p_operation_date>current_date then raise exception 'Дата операции не может быть в будущем'; end if; if not exists(select 1 from public.contractors where id=p_contractor_id and workspace_id=v_workspace) then raise exception 'Контрагент не найден'; end if; if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Нет товаров для операции'; end if;
 v_role:=case when p_type='ARRIVAL' then 'ARRIVAL' else 'SHIPMENT' end; v_num:=public.next_operation_number(v_workspace,p_operation_date);
 insert into public.operations(workspace_id,operation_number,operation_date,type,role,contractor_id,created_by,note) values(v_workspace,v_num,p_operation_date,p_type,v_role,p_contractor_id,auth.uid(),p_note) returning id into v_id;
 for v_item in select * from jsonb_array_elements(p_items) loop
  v_name:=trim(v_item->>'name');
  v_product:=nullif(v_item->>'product_id','')::uuid;
  v_qty:=(v_item->>'kg')::numeric; v_price:=(v_item->>'price')::numeric; v_waste:=coalesce((v_item->>'wasteKg')::numeric,0);
  if v_product is null then select id into v_product from public.products where workspace_id=v_workspace and lower(name)=lower(v_name) and status='ACTIVE'; end if;
  if v_product is null then raise exception 'Товар не найден: %',coalesce(v_name,''); end if;
  if v_qty is null or v_qty<=0 then raise exception 'Количество должно быть больше 0'; end if; if v_price is null or v_price<0 then raise exception 'Цена не может быть отрицательной'; end if; if v_waste<0 or v_waste>v_qty then raise exception 'Отход не может быть больше количества'; end if;
  if v_product=any(v_seen) then raise exception 'Товар указан в операции более одного раза: %',coalesce(v_name,v_product::text); end if; v_seen:=array_append(v_seen,v_product);
  if p_type='SHIPMENT' then perform public.lock_product(v_workspace,v_product); end if;
  insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg) values(v_workspace,v_id,v_product,v_qty,v_price,v_waste);
 end loop;
 for v_product in select distinct product_id from public.operation_items where operation_id=v_id order by product_id loop perform public.rebuild_product_valuation(v_product,v_workspace); end loop;
 if p_type='SHIPMENT' then if exists(select 1 from public.operation_items where operation_id=v_id and cogs_amount is null) then raise exception 'Не удалось рассчитать себестоимость'; end if; end if;
 insert into public.audit_log(workspace_id,action,operation_id,user_id,new_data,details) values(v_workspace,case when p_type='ARRIVAL' then 'СОЗДАНИЕ ПРИХОДА' else 'СОЗДАНИЕ ОТГРУЗКИ' end,v_id,auth.uid(),jsonb_build_object('type',p_type,'date',p_operation_date,'contractor_id',p_contractor_id,'items',p_items),'Создание операции');
 return v_id;
end; $$;

create or replace function public.update_operation(p_operation_id uuid,p_contractor_id uuid,p_operation_date date,p_items jsonb,p_note text default null) returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_workspace uuid:=public.current_workspace_id(); v_old public.operations%rowtype; v_old_products uuid[]; v_new_products uuid[]; v_product uuid; v_item jsonb; v_product_id uuid; v_name text; v_qty numeric; v_price numeric; v_waste numeric; v_seen uuid[]:='{}'; v_num bigint; v_old_data jsonb; v_new_data jsonb;
begin
 if v_workspace is null then raise exception 'Пользователь не авторизован'; end if; if p_operation_date>current_date then raise exception 'Дата операции не может быть в будущем'; end if;
 select * into v_old from public.operations where id=p_operation_id and workspace_id=v_workspace for update; if not found then raise exception 'Операция не найдена'; end if; if v_old.role='AUTO_REPLENISH' then raise exception 'Технический автоприход редактировать нельзя'; end if;
 if v_old.type='SHIPMENT' and exists(select 1 from public.operations where parent_operation_id=p_operation_id and role='AUTO_REPLENISH') then raise exception 'Старая отгрузка связана с автоприходом и заблокирована для редактирования'; end if;
 if not exists(select 1 from public.contractors where id=p_contractor_id and workspace_id=v_workspace) then raise exception 'Контрагент не найден'; end if;
 select array_agg(distinct product_id) into v_old_products from public.operation_items where operation_id=p_operation_id;
 v_old_data:=jsonb_build_object('type',v_old.type,'role',v_old.role,'date',v_old.operation_date,'contractor_id',v_old.contractor_id,'items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',oi.product_id,'kg',oi.quantity_kg,'price',oi.unit_price,'wasteKg',oi.waste_kg) order by oi.product_id),'[]'::jsonb) from public.operation_items oi where oi.operation_id=p_operation_id),'note',v_old.note);
 for v_item in select * from jsonb_array_elements(p_items) loop
  v_product_id:=nullif(v_item->>'product_id','')::uuid; v_name:=trim(v_item->>'name'); v_qty:=(v_item->>'kg')::numeric; v_price:=(v_item->>'price')::numeric; v_waste:=coalesce((v_item->>'wasteKg')::numeric,0);
  if v_product_id is null then select id into v_product_id from public.products where workspace_id=v_workspace and lower(name)=lower(v_name) and status='ACTIVE'; end if;
  if v_product_id is null then raise exception 'Товар не найден: %',coalesce(v_name,''); end if; if v_qty is null or v_qty<=0 then raise exception 'Количество должно быть больше 0'; end if; if v_price is null or v_price<0 then raise exception 'Цена не может быть отрицательной'; end if; if v_waste<0 or v_waste>v_qty then raise exception 'Отход не может быть больше количества'; end if; if v_product_id=any(v_seen) then raise exception 'Товар указан в операции более одного раза'; end if; v_seen:=array_append(v_seen,v_product_id);
 end loop;
 if v_old.type='SHIPMENT' then for v_product in select unnest(coalesce(v_old_products,'{}'::uuid[])) union select unnest(v_seen) order by 1 loop perform public.lock_product(v_workspace,v_product); end loop; end if;
 delete from public.operation_items where operation_id=p_operation_id;
 v_num:=case when v_old.operation_date=p_operation_date then v_old.operation_number else public.next_operation_number(v_workspace,p_operation_date) end;
 update public.operations set contractor_id=p_contractor_id,operation_date=p_operation_date,operation_number=v_num,updated_at=now(),note=p_note where id=p_operation_id;
 for v_item in select * from jsonb_array_elements(p_items) loop
  v_product_id:=nullif(v_item->>'product_id','')::uuid; v_name:=trim(v_item->>'name'); if v_product_id is null then select id into v_product_id from public.products where workspace_id=v_workspace and lower(name)=lower(v_name) and status='ACTIVE'; end if; v_qty:=(v_item->>'kg')::numeric; v_price:=(v_item->>'price')::numeric; v_waste:=coalesce((v_item->>'wasteKg')::numeric,0);
  insert into public.operation_items(workspace_id,operation_id,product_id,quantity_kg,unit_price,waste_kg) values(v_workspace,p_operation_id,v_product_id,v_qty,v_price,v_waste);
 end loop;
 select array_agg(distinct product_id) into v_new_products from public.operation_items where operation_id=p_operation_id;
 for v_product in select unnest(array(select distinct unnest(coalesce(v_old_products,'{}'::uuid[])) union select distinct unnest(coalesce(v_new_products,'{}'::uuid[])))) order by 1 loop perform public.rebuild_product_valuation(v_product,v_workspace); end loop;
 v_new_data:=jsonb_build_object('type',v_old.type,'role',v_old.role,'date',p_operation_date,'contractor_id',p_contractor_id,'items',p_items,'note',p_note);
 insert into public.audit_log(workspace_id,action,operation_id,user_id,old_data,new_data,details) values(v_workspace,'ИЗМЕНЕНИЕ ОПЕРАЦИИ',p_operation_id,auth.uid(),v_old_data,v_new_data,'БЫЛО → СТАЛО');
 return p_operation_id;
end; $$;

create or replace function public.delete_operation(p_operation_id uuid) returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_workspace uuid:=public.current_workspace_id(); v_old public.operations%rowtype; v_products uuid[]; v_product uuid; v_old_data jsonb;
begin select * into v_old from public.operations where id=p_operation_id and workspace_id=v_workspace for update; if not found then raise exception 'Операция не найдена'; end if; if v_old.role='AUTO_REPLENISH' then raise exception 'Исторический автоприход доступен только для просмотра'; end if; if exists(select 1 from public.operations where parent_operation_id=p_operation_id and role='AUTO_REPLENISH') then raise exception 'Отгрузка связана со старым автоприходом и заблокирована для удаления'; end if;
 select array_agg(distinct product_id) into v_products from public.operation_items where operation_id=p_operation_id; v_old_data:=jsonb_build_object('type',v_old.type,'date',v_old.operation_date,'contractor_id',v_old.contractor_id);
 if v_old.type='SHIPMENT' then for v_product in select unnest(coalesce(v_products,'{}'::uuid[])) order by 1 loop perform public.lock_product(v_workspace,v_product); end loop; end if;
 insert into public.audit_log(workspace_id,action,operation_id,user_id,old_data,details) values(v_workspace,'УДАЛЕНИЕ ОПЕРАЦИИ',p_operation_id,auth.uid(),v_old_data,'Удаление операции');
 delete from public.operations where id=p_operation_id and workspace_id=v_workspace;
 for v_product in select unnest(coalesce(v_products,'{}'::uuid[])) order by 1 loop perform public.rebuild_product_valuation(v_product,v_workspace); end loop;
end; $$;

create or replace function public.rebuild_all_inventory(p_workspace_id uuid) returns void language plpgsql security definer set search_path=public,pg_catalog as $$ declare v_product uuid; begin perform public.ensure_member(p_workspace_id); for v_product in select id from public.products where workspace_id=p_workspace_id order by id loop perform public.rebuild_product_valuation(v_product,p_workspace_id); end loop; end; $$;

create or replace function public.dashboard_summary() returns table(product_id uuid,product_name text,quantity_kg numeric,avg_cost numeric,inventory_value numeric) language sql stable security invoker set search_path=public,pg_catalog as $$ select p.id,p.name,coalesce(i.quantity_kg,0),coalesce(i.avg_cost,0),coalesce(i.cost_amount,0) from public.products p left join public.inventory_balances i on i.product_id=p.id and i.workspace_id=public.current_workspace_id() where p.workspace_id=public.current_workspace_id() and p.status='ACTIVE' order by p.name $$;

create or replace function public.get_profit_report(p_from date default null,p_to date default null) returns jsonb language plpgsql stable security invoker set search_path=public,pg_catalog as $$
declare v_workspace uuid:=public.current_workspace_id(); v_from date:=coalesce(p_from,'1900-01-01'::date); v_to date:=coalesce(p_to,current_date); v_result jsonb;
begin
 select jsonb_build_object(
  'totals',jsonb_build_object('in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.total_amount else 0 end),0),'in_kg',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.quantity_kg else 0 end),0),'out_sum',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount else 0 end),0),'out_kg',coalesce(sum(case when o.type='SHIPMENT' then oi.quantity_kg else 0 end),0),'cogs',coalesce(sum(case when o.type='SHIPMENT' then oi.cogs_amount else 0 end),0),'profit',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount-oi.cogs_amount else 0 end),0)),
  'products',coalesce((select jsonb_agg(x order by (x->>'out_sum')::numeric desc) from (select jsonb_build_object('name',p.name,'in_kg',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.quantity_kg else 0 end),0),'in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.total_amount else 0 end),0),'out_kg',coalesce(sum(case when o.type='SHIPMENT' then oi.quantity_kg else 0 end),0),'out_sum',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount else 0 end),0),'cogs',coalesce(sum(case when o.type='SHIPMENT' then oi.cogs_amount else 0 end),0),'profit',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount-oi.cogs_amount else 0 end),0)) x from operation_items oi join operations o on o.id=oi.operation_id join products p on p.id=oi.product_id where oi.workspace_id=v_workspace and o.operation_date between v_from and v_to group by p.id,p.name) q),'[]'::jsonb),
  'clients',coalesce((select jsonb_agg(x order by (x->>'out_sum')::numeric desc) from (select jsonb_build_object('name',c.name,'group',g.name,'in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.total_amount else 0 end),0),'out_sum',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount else 0 end),0),'cogs',coalesce(sum(case when o.type='SHIPMENT' then oi.cogs_amount else 0 end),0),'profit',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount-oi.cogs_amount else 0 end),0)) x from operations o join operation_items oi on oi.operation_id=o.id join contractors c on c.id=o.contractor_id left join contractor_groups g on g.id=c.group_id where o.workspace_id=v_workspace and o.operation_date between v_from and v_to and o.role<>'AUTO_REPLENISH' group by c.id,c.name,g.name) q),'[]'::jsonb),
  'groups',coalesce((select jsonb_agg(x order by (x->>'out_sum')::numeric desc) from (select jsonb_build_object('name',g.name,'in_sum',coalesce(sum(case when o.type='ARRIVAL' and o.role<>'AUTO_REPLENISH' then oi.total_amount else 0 end),0),'out_sum',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount else 0 end),0),'cogs',coalesce(sum(case when o.type='SHIPMENT' then oi.cogs_amount else 0 end),0),'profit',coalesce(sum(case when o.type='SHIPMENT' then oi.total_amount-oi.cogs_amount else 0 end),0)) x from operations o join operation_items oi on oi.operation_id=o.id join contractors c on c.id=o.contractor_id join contractor_groups g on g.id=c.group_id where o.workspace_id=v_workspace and o.operation_date between v_from and v_to and o.role<>'AUTO_REPLENISH' group by g.id,g.name) q),'[]'::jsonb)
 ) into v_result; return v_result; end; $$;

create or replace function public.upsert_product(p_name text,p_price numeric,p_status public.product_status default 'ACTIVE') returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$ declare v_ws uuid:=public.current_workspace_id(); v_id uuid; v_old numeric; begin perform public.ensure_manager(); select id,default_price into v_id,v_old from products where workspace_id=v_ws and lower(name)=lower(trim(p_name)) for update; if v_id is null then insert into products(workspace_id,name,default_price,status) values(v_ws,trim(p_name),p_price,p_status) returning id into v_id; insert into price_history(workspace_id,product_id,old_price,new_price,source,changed_by) values(v_ws,v_id,0,p_price,'NEW',auth.uid()); else update products set default_price=p_price,status=p_status where id=v_id; if v_old is distinct from p_price then insert into price_history(workspace_id,product_id,old_price,new_price,source,changed_by) values(v_ws,v_id,v_old,p_price,'MANUAL',auth.uid()); end if; end if; return v_id; end; $$;
create or replace function public.upsert_contractor(p_name text,p_group_id uuid default null) returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$ declare v_ws uuid:=public.current_workspace_id(); v_id uuid; begin perform public.ensure_manager(); if p_group_id is not null and not exists(select 1 from contractor_groups where id=p_group_id and workspace_id=v_ws) then raise exception 'Группа не найдена'; end if; select id into v_id from contractors where workspace_id=v_ws and lower(name)=lower(trim(p_name)) for update; if v_id is null then insert into contractors(workspace_id,name,group_id) values(v_ws,trim(p_name),p_group_id) returning id into v_id; else update contractors set group_id=p_group_id where id=v_id; end if; return v_id; end; $$;
create or replace function public.save_client_group(p_parent_name text,p_child_name text) returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$ declare v_ws uuid:=public.current_workspace_id(); v_gid uuid; v_cid uuid; begin perform public.ensure_manager(); if lower(trim(p_parent_name))=lower(trim(p_child_name)) then raise exception 'Общий и мини-контрагент должны отличаться'; end if; insert into contractor_groups(workspace_id,name) values(v_ws,trim(p_parent_name)) on conflict(workspace_id,lower(name)) do update set name=excluded.name returning id into v_gid;
 insert into contractors(workspace_id,name,group_id) values(v_ws,trim(p_parent_name),v_gid) on conflict(workspace_id,lower(name)) do update set group_id=excluded.group_id;
 select id into v_cid from contractors where workspace_id=v_ws and lower(name)=lower(trim(p_child_name)); if v_cid is null then insert into contractors(workspace_id,name,group_id) values(v_ws,trim(p_child_name),v_gid) returning id into v_cid; else if exists(select 1 from contractors where id=v_cid and group_id is not null and group_id<>v_gid) then raise exception 'Этот мини-контрагент уже привязан к другой группе'; end if; update contractors set group_id=v_gid where id=v_cid; end if; return jsonb_build_object('group_id',v_gid,'contractor_id',v_cid); end; $$;

-- RLS
alter table public.workspaces enable row level security; alter table public.profiles enable row level security; alter table public.products enable row level security; alter table public.price_history enable row level security; alter table public.contractor_groups enable row level security; alter table public.contractors enable row level security; alter table public.operations enable row level security; alter table public.operation_items enable row level security; alter table public.inventory_balances enable row level security; alter table public.audit_log enable row level security;
create policy workspace_select on public.workspaces for select to authenticated using(id=public.current_workspace_id());
create policy profile_select on public.profiles for select to authenticated using(workspace_id=public.current_workspace_id());
create policy products_select on public.products for select to authenticated using(workspace_id=public.current_workspace_id());
create policy products_write on public.products for all to authenticated using(workspace_id=public.current_workspace_id() and public.current_user_role() in ('admin','manager')) with check(workspace_id=public.current_workspace_id() and public.current_user_role() in ('admin','manager'));
create policy price_history_select on public.price_history for select to authenticated using(workspace_id=public.current_workspace_id());
create policy groups_select on public.contractor_groups for select to authenticated using(workspace_id=public.current_workspace_id());
create policy contractors_select on public.contractors for select to authenticated using(workspace_id=public.current_workspace_id());
create policy operations_select on public.operations for select to authenticated using(workspace_id=public.current_workspace_id());
create policy operation_items_select on public.operation_items for select to authenticated using(workspace_id=public.current_workspace_id());
create policy inventory_select on public.inventory_balances for select to authenticated using(workspace_id=public.current_workspace_id());
create policy audit_select on public.audit_log for select to authenticated using(workspace_id=public.current_workspace_id());
revoke insert,update,delete on public.operations from authenticated,anon;
revoke insert,update,delete on public.operation_items from authenticated,anon;
revoke insert,update,delete on public.inventory_balances from authenticated,anon;
revoke insert,update,delete on public.audit_log from authenticated,anon;
revoke insert,update,delete on public.price_history from authenticated,anon;
revoke execute on function public.post_operation(public.operation_type,uuid,date,jsonb,text) from public; grant execute on function public.post_operation(public.operation_type,uuid,date,jsonb,text) to authenticated;
revoke execute on function public.update_operation(uuid,uuid,date,jsonb,text) from public; grant execute on function public.update_operation(uuid,uuid,date,jsonb,text) to authenticated;
revoke execute on function public.delete_operation(uuid) from public; grant execute on function public.delete_operation(uuid) to authenticated;
revoke execute on function public.upsert_product(text,numeric,public.product_status) from public; grant execute on function public.upsert_product(text,numeric,public.product_status) to authenticated;
revoke execute on function public.upsert_contractor(text,uuid) from public; grant execute on function public.upsert_contractor(text,uuid) to authenticated;
revoke execute on function public.save_client_group(text,text) from public; grant execute on function public.save_client_group(text,text) to authenticated;
commit;
