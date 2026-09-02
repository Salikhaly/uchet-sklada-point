# Учёт склада V6 — no-login internal mode

Эта версия открывает склад сразу без экрана логина.

Данные берутся из текущего Supabase workspace «Метал». История операций и уже импортированные данные не сбрасываются.

Для запуска:

```cmd
npm install
npm run build
npm run dev
```

Для Supabase:

```cmd
npx supabase db push
```

Новая миграция `202608290007_no_login_internal_access.sql` оставляет RLS включённым, но добавляет доступ роли `anon` только к выбранному workspace и переводит server-side manager checks в internal-admin режим.

Важно: режим без логина означает, что приложение нельзя считать публично защищённым. Для production желательно закрыть домен дополнительной защитой (например, Vercel Authentication/Access или корпоративным VPN).
