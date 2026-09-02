# Local-only запуск

1. `supabase start`
2. `npm install`
3. `npm run repair:local`
4. `npm run dev`

`.env.local`:

```env
LOCAL_ONLY_MODE=true
NEXT_PUBLIC_LOCAL_ONLY=true
```

`/api/app-mode` автоматически вызывает `ensureLocalPointSchema()` перед чтением профиля. Если локальная схема старая, миграция добавит `point_workspace_id` и `active_mode`. При `LOCAL_ONLY_MODE=true` подключение к удалённому PostgreSQL блокируется.
