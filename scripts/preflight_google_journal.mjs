import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const outArg = args.find(a => a.startsWith('--out='));
const outFile = outArg ? outArg.split('=').slice(1).join('=') : 'preflight_google_journal.json';

if (!file) {
  console.error('Usage: node scripts/preflight_google_journal.mjs ./Общий_журнал.csv [--out=report.json]');
  process.exit(1);
}

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const requestedWorkspaceId = process.env.SUPABASE_WORKSPACE_ID || '';
if (!url || !key) {
  throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY');
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function resolveWorkspaceId() {
  if (requestedWorkspaceId) {
    const got = await supabase.from('workspaces').select('id,name').eq('id', requestedWorkspaceId).single();
    if (got.error) throw new Error(`Workspace not found: ${requestedWorkspaceId}. ${got.error.message}`);
    console.log(`Workspace: ${got.data.name} (${got.data.id})`);
    return got.data.id;
  }
  const all = await supabase.from('workspaces').select('id,name,created_at').order('created_at',{ascending:true});
  if (all.error) throw all.error;
  if (!all.data?.length) throw new Error('В Supabase пока нет workspace. Сначала зарегистрируйте пользователя в приложении.');
  if (all.data.length > 1) {
    const lines = all.data.map(x => ` - ${x.id} | ${x.name}`).join('\n');
    throw new Error('Найдено несколько workspace. Задайте SUPABASE_WORKSPACE_ID из списка:\n' + lines);
  }
  console.log(`Workspace выбран автоматически: ${all.data[0].name} (${all.data[0].id})`);
  return all.data[0].id;
}

const workspaceId = await resolveWorkspaceId();

function n(v) {
  const s = String(v ?? '').trim().replace(/\s+/g, '').replace(',', '.');
  if (!s) return 0;
  const x = Number(s);
  return Number.isFinite(x) ? x : 0;
}
function dateIso(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error(`Некорректная дата: ${s}`);
}
function opNum(label) {
  const m = String(label || '').match(/№\s*(\d+)/);
  return m ? Number(m[1]) : null;
}
function isHeaderRow(r) {
  const contractor = String(r[0] ?? '').trim();
  const date = String(r[1] ?? '').trim();
  const type = String(r[2] ?? '').trim();
  return Boolean(contractor && date && /^(ПРИХОД|ОТГРУЗКА|АВТОПРИХОД)/i.test(type));
}

const raw = fs.readFileSync(file, 'utf8');
const rows = parse(raw, { bom: true, skip_empty_lines: true, relax_column_count: true });
if (rows.length < 2) throw new Error('CSV пустой');

// This CSV is exported from the actual Google Sheet where the first 10 columns have no header labels.
// Map by known V6 positions instead of relying on header names.
const blocks = [];
let current = null;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (isHeaderRow(r)) {
    const typeLabel = String(r[2]).trim();
    current = {
      sourceRow: i + 1,
      contractor: String(r[0]).trim(),
      date: dateIso(r[1]),
      headerLabel: typeLabel,
      type: /ОТГРУЗКА/i.test(typeLabel) ? 'SHIPMENT' : 'ARRIVAL',
      role: String(r[15] || '').trim().toUpperCase() || (/ОТГРУЗКА/i.test(typeLabel) ? 'SHIPMENT' : 'ARRIVAL'),
      operationNumber: opNum(typeLabel),
      legacyOperationId: String(r[11] || '').trim(),
      legacyParentOperationId: String(r[14] || '').trim() || null,
      createdRaw: String(r[12] || '').trim(),
      items: []
    };
    blocks.push(current);
    continue;
  }
  if (!current) continue;
  const product = String(r[3] || '').trim();
  const kgRaw = String(r[4] || '').trim();
  const priceRaw = String(r[5] || '').trim();
  const totalRaw = String(r[6] || '').trim();
  if (!product || !kgRaw) continue;
  // Skip ИТОГО / formatting rows.
  if (/^ИТОГО$/i.test(String(r[7] || '').trim())) continue;
  const kgSigned = n(kgRaw);
  if (!Number.isFinite(kgSigned) || kgSigned === 0) continue;
  const quantity = Math.abs(kgSigned);
  const price = n(priceRaw);
  const total = Math.abs(n(totalRaw));
  const waste = Math.abs(n(r[10] || 0));
  current.items.push({ name: product, quantityKg: quantity, unitPrice: price, totalAmount: total, wasteKg: waste });
}

const errors = [];
const warnings = [];
const productObservations = new Map();
const legacyIds = new Set();
const dateNumbers = new Map();
const contractors = new Set();
let itemCount = 0;
let arrivalCount = 0;
let shipmentCount = 0;
const simulatedStock = new Map();
const historicalShortages = [];

for (const b of blocks) {
  if (!b.legacyOperationId) errors.push(`Операция без ID: ${b.headerLabel} (строка ${b.sourceRow})`);
  if (legacyIds.has(b.legacyOperationId)) errors.push(`Дублируется ID операции: ${b.legacyOperationId}`);
  if (b.legacyOperationId) legacyIds.add(b.legacyOperationId);
  if (!b.operationNumber) warnings.push(`Нет номера операции: ${b.headerLabel}`);
  else {
    const key = `${b.date}|${b.operationNumber}`;
    if (dateNumbers.has(key)) errors.push(`Дублируются дата+номер: ${key}`);
    dateNumbers.set(key, b.headerLabel);
  }
  if (!b.items.length) errors.push(`Пустая операция: ${b.headerLabel}`);
  contractors.add(b.contractor);
  if (b.type === 'ARRIVAL') arrivalCount++; else shipmentCount++;
  itemCount += b.items.length;
  for (const item of b.items) {
    if (item.wasteKg > item.quantityKg) errors.push(`${b.headerLabel}: отход > кг для ${item.name}`);
    const obs = productObservations.get(item.name) || { name: item.name, count: 0, prices: [], minPrice: null, maxPrice: null };
    obs.count++;
    obs.prices.push(item.unitPrice);
    obs.minPrice = obs.minPrice == null ? item.unitPrice : Math.min(obs.minPrice, item.unitPrice);
    obs.maxPrice = obs.maxPrice == null ? item.unitPrice : Math.max(obs.maxPrice, item.unitPrice);
    productObservations.set(item.name, obs);
  }
}

// Historical stock simulation before import. Migration must never silently clamp a legacy shipment.
const chronologicalBlocks = [...blocks].sort((a,b) => {
  const da = a.date.localeCompare(b.date);
  if (da) return da;
  const na = a.operationNumber ?? Number.MAX_SAFE_INTEGER;
  const nb = b.operationNumber ?? Number.MAX_SAFE_INTEGER;
  return na - nb;
});
for (const b of chronologicalBlocks) {
  for (const item of b.items) {
    const prev = simulatedStock.get(item.name) || 0;
    if (b.type === 'SHIPMENT') {
      if (item.quantityKg > prev + 1e-9) {
        historicalShortages.push({ operation:b.headerLabel, product:item.name, availableKg:prev, requestedKg:item.quantityKg, shortageKg:item.quantityKg-prev });
      }
      simulatedStock.set(item.name, Math.max(0, prev - item.quantityKg));
    } else {
      simulatedStock.set(item.name, prev + item.quantityKg);
    }
  }
}
if (historicalShortages.length) warnings.push(`Исторических отгрузок с нехваткой остатка: ${historicalShortages.length}`);

const allProductsRes = await supabase.from('products').select('name,default_price,status').eq('workspace_id', workspaceId);
if (allProductsRes.error) throw allProductsRes.error;
const dbProducts = new Map((allProductsRes.data || []).map(p => [String(p.name).trim().toLowerCase(), p]));
const missingProducts = [];
for (const obs of productObservations.values()) {
  if (!dbProducts.has(obs.name.toLowerCase())) {
    const suggestedPrice = obs.prices.find(p => p > 0) ?? obs.prices[0] ?? 0;
    missingProducts.push({ name: obs.name, suggestedPrice, occurrences: obs.count, minPrice: obs.minPrice, maxPrice: obs.maxPrice });
  }
}

const existingLegacyRes = legacyIds.size
  ? await supabase.from('operations').select('legacy_operation_id').eq('workspace_id', workspaceId).in('legacy_operation_id', [...legacyIds])
  : { data: [], error: null };
if (existingLegacyRes.error) throw existingLegacyRes.error;
const existingLegacyIds = new Set((existingLegacyRes.data || []).map(x => x.legacy_operation_id));

for (const b of blocks) {
  if (existingLegacyIds.has(b.legacyOperationId)) warnings.push(`Уже импортирована, будет пропущена: ${b.headerLabel} / ${b.legacyOperationId}`);
}

// Detect suspicious old Google Sheet creation dates; we will preserve operation order by date+number instead.
const suspiciousCreatedAt = blocks.filter(b => {
  if (!b.createdRaw) return true;
  const m = b.createdRaw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return !m || Number(m[3]) < 2024;
}).map(b => ({ headerLabel: b.headerLabel, operationDate: b.date, createdRaw: b.createdRaw }));
if (suspiciousCreatedAt.length) warnings.push(`У ${suspiciousCreatedAt.length} операций нет надёжного времени создания; импортёр будет строить детерминированное created_at из даты + номера операции.`);

const report = {
  file: path.resolve(file),
  source: 'Google Sheets V6 Общий журнал',
  summary: {
    operations: blocks.length,
    arrivals: arrivalCount,
    shipments: shipmentCount,
    itemRows: itemCount,
    contractors: contractors.size,
    products: productObservations.size,
    alreadyImported: existingLegacyIds.size,
    missingProducts: missingProducts.length,
    errors: errors.length,
    warnings: warnings.length
  },
  missingProducts,
  products: [...productObservations.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
  suspiciousCreatedAt,
  historicalShortages,
  errors,
  warnings
};

fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Preflight report: ${path.resolve(outFile)}`);
if (missingProducts.length) console.log('Missing products:', missingProducts.map(x => `${x.name} => ${x.suggestedPrice}`).join('; '));
if (errors.length) process.exitCode = 2;
