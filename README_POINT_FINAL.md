# Точка — финальный слой

## Что готово

Точка работает в отдельном `workspace` через `profiles.point_workspace_id` и использует общие таблицы склада Ангара с изоляцией по `workspace_id`:

- `products`
- `contractors`
- `operations`
- `operation_items`
- `inventory_balances`
- `audit_log`

Отдельный финансовый/вечерний слой:

- `point_employees`
- `point_evening_summaries`
- `point_evening_expenses`
- `point_transfers`

## Рабочий поток

`Приёмка → Отгрузка → Продажа → Перемещение в Ангар → Вечерняя сводка → Остатки → Журнал → Отчёты → Audit`

Приёмка/отгрузка/продажа/перемещение проводятся как накопленные операции. Вечерняя сводка не просит повторно вводить уже проведённые движения.

Расходы вводятся вечером: сотрудник, категория, комментарий, сумма.

## База

Новая финальная миграция:

`supabase/migrations/202609010001_point_final.sql`

Существующие функции Ангара `current_workspace_id()`, `post_operation()` и `rebuild_product_valuation()` не переписываются.

Для Точки используются:

- `current_point_workspace_id()`
- `ensure_point_member()`
- `point_post_operation()`
- `rebuild_point_product_valuation()`
- `point_transfer_to_angar()`
- `point_save_evening_summary()`
- `point_add_evening_expense()`
- `point_check_day()`
- `point_close_day()`
- `point_reopen_day()`
- `point_get_report()`
- `point_get_audit_report()`

## Деплой БД

1. Supabase → SQL Editor.
2. Выполнить `supabase/migrations/202609010001_point_final.sql` целиком.
3. Не выполнять `supabase start` для production Supabase.
4. После миграции открыть приложение и проверить вход в Точку.

## Проверка

После миграции:

```sql
select
  p.proname,
  pg_get_function_identity_arguments(p.oid)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public'
  and p.proname in (
    'point_post_operation',
    'point_transfer_to_angar',
    'point_save_evening_summary',
    'point_get_report',
    'point_get_audit_report'
  )
order by p.proname, 2;
```

Для локальной проверки профиля:

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
$env:SUPABASE_SECRET_KEY="YOUR_SECRET_KEY"
npm run verify:profile:native
```

## Важно

Не добавлять `SUPABASE_SECRET_KEY` в Git и `.env` репозитория.
