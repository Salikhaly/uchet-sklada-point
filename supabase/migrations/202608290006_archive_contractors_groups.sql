begin;

alter table public.contractors add column if not exists archived_at timestamptz;
alter table public.contractor_groups add column if not exists archived_at timestamptz;

-- Allow a name to be recreated after it has been archived, while keeping history intact.
drop index if exists public.contractors_workspace_name_uq;
create unique index if not exists contractors_workspace_name_active_uq
  on public.contractors(workspace_id, lower(name)) where archived_at is null;
drop index if exists public.contractor_groups_workspace_name_uq;
create unique index if not exists contractor_groups_workspace_name_active_uq
  on public.contractor_groups(workspace_id, lower(name)) where archived_at is null;

create or replace function public.archive_contractor(p_contractor_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id();
begin
  perform public.ensure_manager();
  update public.contractors
     set archived_at=coalesce(archived_at,now())
   where id=p_contractor_id and workspace_id=v_ws;
  if not found then raise exception 'Контрагент не найден'; end if;
end; $$;

grant execute on function public.archive_contractor(uuid) to authenticated;

create or replace function public.archive_contractor_group(p_group_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id();
begin
  perform public.ensure_manager();
  update public.contractor_groups
     set archived_at=coalesce(archived_at,now())
   where id=p_group_id and workspace_id=v_ws;
  if not found then raise exception 'Группа не найдена'; end if;
end; $$;

grant execute on function public.archive_contractor_group(uuid) to authenticated;

-- Revive archived names when the same entity is explicitly reused.
create or replace function public.upsert_contractor(p_name text,p_group_id uuid default null)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_id uuid;
begin
  perform public.ensure_manager();
  if p_group_id is not null and not exists(select 1 from contractor_groups where id=p_group_id and workspace_id=v_ws) then raise exception 'Группа не найдена'; end if;
  select id into v_id from contractors where workspace_id=v_ws and lower(name)=lower(trim(p_name)) order by archived_at nulls first, created_at desc limit 1 for update;
  if v_id is null then
    insert into contractors(workspace_id,name,group_id) values(v_ws,trim(p_name),p_group_id) returning id into v_id;
  else
    update contractors set group_id=p_group_id, archived_at=null where id=v_id;
  end if;
  return v_id;
end; $$;

drop function if exists public.save_client_group(text,text);
create or replace function public.save_client_group(p_parent_name text,p_child_name text)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ws uuid:=public.current_workspace_id(); v_gid uuid; v_cid uuid;
begin
  perform public.ensure_manager();
  if lower(trim(p_parent_name))=lower(trim(p_child_name)) then raise exception 'Общий и мини-контрагент должны отличаться'; end if;
  select id into v_gid from contractor_groups where workspace_id=v_ws and lower(name)=lower(trim(p_parent_name)) order by archived_at nulls first, created_at desc limit 1 for update;
  if v_gid is null then
    insert into contractor_groups(workspace_id,name) values(v_ws,trim(p_parent_name)) returning id into v_gid;
  else
    update contractor_groups set archived_at=null where id=v_gid;
  end if;
  select id into v_cid from contractors where workspace_id=v_ws and lower(name)=lower(trim(p_parent_name)) order by archived_at nulls first, created_at desc limit 1 for update;
  if v_cid is null then
    insert into contractors(workspace_id,name,group_id) values(v_ws,trim(p_parent_name),v_gid) returning id into v_cid;
  else
    update contractors set group_id=v_gid, archived_at=null where id=v_cid;
  end if;
  select id into v_cid from contractors where workspace_id=v_ws and lower(name)=lower(trim(p_child_name)) order by archived_at nulls first, created_at desc limit 1 for update;
  if v_cid is null then
    insert into contractors(workspace_id,name,group_id) values(v_ws,trim(p_child_name),v_gid) returning id into v_cid;
  else
    if exists(select 1 from contractors where id=v_cid and group_id is not null and group_id<>v_gid and archived_at is null) then raise exception 'Этот мини-контрагент уже привязан к другой группе'; end if;
    update contractors set group_id=v_gid, archived_at=null where id=v_cid;
  end if;
  return jsonb_build_object('group_id',v_gid,'contractor_id',v_cid);
end; $$;

grant execute on function public.save_client_group(text,text) to authenticated;

commit;
