# Local V8 — Ангар / Точка

Эта версия предназначена только для localhost. Боевой Supabase/деплой не нужно менять или накатывать туда миграции.

## Ошибка `Could not find the function public.switch_app_mode(p_mode)`
В локальной базе функция могла не быть применена. В Local V8 кнопки **Ангар** и **Точка** не зависят от этой RPC-функции: при `LOCAL_ONLY_MODE=true` переключение идёт через локальный серверный endpoint `/api/app-mode`.

Для полноценной работы Точки локальная БД должна иметь колонки `profiles.point_workspace_id`, `profiles.active_mode` и mode-aware `current_workspace_id()`. Если локальная база поднята через этот репозиторий, безопасный локальный способ — один раз выполнить:

```bash
supabase db reset
```

Эта команда действует только на локальный Supabase, запущенный через Supabase CLI. Не выполняйте `supabase db push` на production.

## Переменные
```env
LOCAL_ONLY_MODE=true
NEXT_PUBLIC_LOCAL_ONLY=true
```

После изменения env перезапустите `npm run dev`.


### В этой локальной сборке
Кнопки Ангар/Точка **никогда не вызывают** `public.switch_app_mode`. Переключение выполняется только через `/api/app-mode`.
