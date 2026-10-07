-- В point_get_report блок products не исключал отменённые операции (итоги и days — исключали),
-- поэтому после отмены прихода таблица металла расходилась с итогами. Правим точечно: берём
-- действующее определение функции, добавляем фильтр статуса и пересоздаём. Если нужный фрагмент
-- не найден — ничего не меняем (ошибка).
do $$
declare
  d text;
  needle text := $n$ and coalesce(o.note,'') not like '[STOCKTAKE]%' where p.workspace_id=v_ws and p.status='ACTIVE'$n$;
  fixed  text := $r$ and coalesce(o.note,'') not like '[STOCKTAKE]%' and coalesce(o.status,'CONFIRMED')<>'CANCELLED' where p.workspace_id=v_ws and p.status='ACTIVE'$r$;
begin
  d := pg_get_functiondef('public.point_get_report(date,date)'::regprocedure);
  if position(fixed in d) > 0 then raise notice 'Уже применено'; return; end if;
  if position(needle in d) = 0 then raise exception 'Фрагмент блока products не найден — патч не применён'; end if;
  d := replace(d, needle, fixed);
  execute d;
end $$;
