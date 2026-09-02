# Как применить финальную Точку

1. Сделай backup/снимок production Supabase.
2. Supabase → SQL Editor → выполни `supabase/migrations/202609010001_point_final.sql` целиком.
3. Пересобери/перезапусти Next.js проект.
4. Проверь `/point` под авторизованным пользователем.
5. Проверь: Приёмка → Отгрузка → Продажа → В Ангар → Вечерняя сводка → Отчёты → Audit.

Функции Ангара `current_workspace_id()`, `post_operation()` и `rebuild_product_valuation()` не изменяются.

Для перемещения UI использует `point_transfer_to_angar(jsonb,date,uuid,text)`. Старый двухпараметровый wrapper также остаётся для совместимости.
