# V13 — защищённый вход

- Логин UI: `Ansar`.
- Внутренний email: `ansar@warehouse.local`.
- Пароль задаётся один раз через `scripts/bootstrap_ansar.mjs` и не хранится в коде.
- Сессия сохраняется на устройстве через Supabase Auth.
- После миграции 202608290009 анонимный доступ к складским таблицам отключён.

## Первый запуск

1. Выполнить миграцию: `npx supabase db push`.
2. Установить секреты в PowerShell:
   `$env:SUPABASE_URL='https://...supabase.co'`
   `$env:SUPABASE_SECRET_KEY='...'`
3. Запустить `node .\\scripts\\bootstrap_ansar.mjs` и ввести пароль.
4. `npm run build` и `npm run dev`.

Не добавляйте `SUPABASE_SECRET_KEY` в `NEXT_PUBLIC_*` переменные или в клиентский код.
