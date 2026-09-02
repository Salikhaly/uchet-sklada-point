# Запуск V2

1. Скопируйте `.env.example` в `.env.local` и задайте:

```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SECRET_KEY=...
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

2. Установите зависимости:

```bash
npm install
```

3. Выкатите новую миграцию:

```bash
npx supabase db push
```

4. Проверьте код:

```bash
npm run typecheck
npm run build
```

5. Запустите:

```bash
npm run dev
```

6. В Supabase/Auth зарегистрируйте пользователя. После регистрации trigger создаёт workspace.

В Vercel выставьте те же переменные окружения. `SUPABASE_SECRET_KEY` никогда не должен попадать в `NEXT_PUBLIC_*` и браузерный bundle. Для Next.js Supabase рекомендует cookie-based SSR через `@supabase/ssr`. citeturn507622search0turn507622search1

## Миграция

Старые 60 операций уже можно импортировать в текущий workspace через migration script. После обновления схемы убедитесь, что импортированные операции имеют `status='CONFIRMED'` и `version=1`.
