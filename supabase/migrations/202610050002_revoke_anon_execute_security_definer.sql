-- Защита в глубину: ни одна функция SECURITY DEFINER в public не должна быть
-- выполнима ролью anon (неавторизованный запрос с публичным anon-ключом).
-- current_workspace_id()/current_point_workspace_id() уже возвращают null для
-- anon, поэтому практической дыры сегодня нет, но сам грант на anon — лишняя
-- поверхность: один будущий баг в любой из функций станет сразу эксплуатируемым
-- без дополнительных условий. anon не используется ни для одного сценария в
-- этом приложении (RLS для anon нигде не включён), так что ревок безопасен.
do $$
declare r record;
begin
  for r in
    select p.oid, p.proname,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef=true
  loop
    execute format('revoke all on function public.%I(%s) from public, anon', r.proname, r.args);
  end loop;
end $$;
