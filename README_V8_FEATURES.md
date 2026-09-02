# Warehouse V8 — mobile/desktop operations, price history, hard delete, product order

Included changes:
- Mobile-first arrival/shipment entry with large touch targets and sticky save bar.
- Existing default prices and price clearing logic preserved.
- Product card separates actual arrival prices and shipment prices; price changes remain separate.
- Shipment journal rows show average cost per kg and COGS/profit for shipped items.
- Full invoice deletion is available from Journal after explicit confirmation and rebuilds affected inventory.
- Product order is persisted in Supabase and can be changed with ↑ / ↓ controls on desktop or phone.
- 10-second undo after creating an operation is preserved.
- Supabase migration: `202608290008_product_order_delete.sql`.

After replacing the current project with this version:

```powershell
npx supabase db push
npm install
npm run build
npm run dev
```

Do not reset the database or re-import the historical CSV.
