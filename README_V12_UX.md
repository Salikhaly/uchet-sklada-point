# V12 UX — phone-first Point UI

Changes in this release:
- Product order in entry, stock, and report screens follows `products.sort_order`.
- Daily journal cards show operation time, explicit action (ПРИЁМКА / ОТГРУЗКА / ПРОДАЖА / В АНГАР), and the contractor with a human-readable verb (Привёз / Увёз / Продал / Переместил).
- Mobile typography and controls are enlarged for easier reading and touch input.
- Journal product chips are larger and readable on phones.
- Stock cards and report product cards use the same product order as the entry sheet.
- Mobile numeric/select controls use larger touch targets and 16px text to reduce browser zooming.

Build note: npm dependencies were not available long enough in the packaging environment to complete a Next.js production build. Run `npm install && npm run build` in the project before deployment.
