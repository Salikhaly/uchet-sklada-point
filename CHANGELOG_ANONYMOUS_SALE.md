# Anonymous retail sale
- Shipment/sale no longer requires a counterparty.
- UI says "Обычная продажа без контрагента" instead of asking for a buyer.
- User can enter product + kg + total amount; price/kg recalculates automatically.
- Backend allows NULL contractor only for SHIPMENT; ARRIVAL still requires contractor.
- Anonymous sales remain in journal, stock, daily totals, COGS and gross profit, but do not appear in client/contractor reports.
- COGS continues to be calculated by current average stock cost via rebuild_product_valuation().
