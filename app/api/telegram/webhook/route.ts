import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendMessage, answerCallbackQuery, type InlineButton } from '@/lib/telegram/client';
import { redis } from '@/lib/redis';

// Telegram-бот для Ангара: приёмка товара кнопками + отчёт по запросу.
// Доступ к боту — по списку разрешённых telegram_user_id (telegram_bot_users).
// Все операции проводятся через telegram_post_arrival/telegram_today_summary —
// эти функции в базе доступны только service_role и сами проверяют allowlist.

function workspaceId() {
  const id = process.env.SUPABASE_WORKSPACE_ID;
  if (!id) throw new Error('SUPABASE_WORKSPACE_ID не задан');
  return id;
}

function ownerId(): number | null {
  const v = process.env.TELEGRAM_OWNER_ID;
  return v ? Number(v) : null;
}

const admin = () => createAdminClient();

type CatalogProduct = { id: string; name: string; default_price: number };
type CatalogContractor = { id: string; name: string };
type Session = {
  step?: string; contractor_id?: string; contractor_name?: string;
  items?: Array<{ product_id: string; product_name: string; kg: number; price: number }>;
  pending_product_id?: string; pending_product_name?: string; pending_default_price?: number; pending_kg?: number;
};

// Черновик накладной живёт в Redis (миллисекунды) — в Supabase бот ходит
// только при «Завершить». Если Redis не настроен или недоступен, откат на
// таблицу telegram_bot_sessions, чтобы бот не падал.
const SESSION_TTL_S = 6 * 60 * 60;
const sessKey = (chatId: number) => `sess:${chatId}`;

async function getSession(chatId: number): Promise<Session> {
  if (redis) {
    try { return (await redis.get<Session>(sessKey(chatId))) || {}; }
    catch (e) { console.error('REDIS_GET_SESSION', e); }
  }
  const { data } = await admin().from('telegram_bot_sessions').select('state').eq('chat_id', chatId).maybeSingle();
  return (data?.state as Session) || {};
}
async function setSession(chatId: number, telegramUserId: number, state: Session) {
  if (redis) {
    try { await redis.set(sessKey(chatId), state, { ex: SESSION_TTL_S }); return; }
    catch (e) { console.error('REDIS_SET_SESSION', e); }
  }
  await admin().from('telegram_bot_sessions').upsert({ chat_id: chatId, telegram_user_id: telegramUserId, state, updated_at: new Date().toISOString() });
}
async function clearSession(chatId: number) {
  if (redis) {
    try { await redis.del(sessKey(chatId)); }
    catch (e) { console.error('REDIS_DEL_SESSION', e); }
  }
  await admin().from('telegram_bot_sessions').delete().eq('chat_id', chatId);
}

// Кэш разрешений живёт в памяти «тёплой» функции. Кэшируем только «да»:
// новая заявка одобряется сразу, а отзыв доступа действует максимум через минуту.
const ALLOW_TTL_MS = 60_000;
const allowCache = new Map<number, number>();
async function isAllowed(telegramUserId: number): Promise<boolean> {
  const exp = allowCache.get(telegramUserId);
  if (exp && exp > Date.now()) return true;
  if (redis) {
    try {
      if (await redis.get(`allow:${telegramUserId}`)) { allowCache.set(telegramUserId, Date.now() + ALLOW_TTL_MS); return true; }
    } catch (e) { console.error('REDIS_GET_ALLOW', e); }
  }
  const { data } = await admin().from('telegram_bot_users').select('allowed').eq('telegram_user_id', telegramUserId).maybeSingle();
  if (data?.allowed) {
    allowCache.set(telegramUserId, Date.now() + ALLOW_TTL_MS);
    if (redis) { try { await redis.set(`allow:${telegramUserId}`, 1, { ex: ALLOW_TTL_MS / 1000 }); } catch (e) { console.error('REDIS_SET_ALLOW', e); } }
  }
  return !!data?.allowed;
}
async function isOwner(telegramUserId: number): Promise<boolean> {
  if (telegramUserId === ownerId()) return true;
  const { data } = await admin().from('telegram_bot_users').select('is_owner').eq('telegram_user_id', telegramUserId).maybeSingle();
  return !!data?.is_owner;
}

const money = (v: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v) + ' ₸';
const qty = (v: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(v) + ' кг';
const parseNum = (t: string) => { const n = Number(String(t).trim().replace(',', '.')); return Number.isFinite(n) ? n : null; };

const mainMenu: InlineButton[][] = [
  [{ text: '📥 Приёмка', callback_data: 'arr:start' }],
  [{ text: '📊 Отчёт за сегодня', callback_data: 'rep:today' }],
];

async function ensureRegistered(telegramUserId: number, username: string | undefined, displayName: string) {
  const { data } = await admin().from('telegram_bot_users').select('telegram_user_id').eq('telegram_user_id', telegramUserId).maybeSingle();
  if (data) return;
  const owner = telegramUserId === ownerId();
  await admin().from('telegram_bot_users').insert({
    telegram_user_id: telegramUserId, username: username || null, display_name: displayName,
    allowed: owner, is_owner: owner, approved_at: owner ? new Date().toISOString() : null,
  });
}

async function requestAccess(telegramUserId: number, username: string | undefined, displayName: string) {
  const owner = ownerId();
  if (!owner) return;
  const label = username ? `@${username}` : displayName;
  await sendMessage(owner, `🔔 Новый запрос доступа к боту Ангара от <b>${displayName}</b> (${label}, id ${telegramUserId}).`, [[
    { text: '✅ Разрешить', callback_data: `appr:${telegramUserId}` },
    { text: '🚫 Отклонить', callback_data: `rej:${telegramUserId}` },
  ]]);
}

// Справочник товаров/поставщиков меняется редко, поэтому держим его в памяти
// функции (не в сессии: иначе он ездит в базу и обратно на каждом шаге).
type Catalog = { products: CatalogProduct[]; contractors: CatalogContractor[] };
const CATALOG_TTL_MS = 5 * 60_000;
let catalogCache: { at: number; data: Catalog } | null = null;

async function loadCatalog(): Promise<Catalog> {
  const ws = workspaceId();
  const [productsRes, contractorsRes] = await Promise.all([
    admin().from('products').select('id,name,default_price').eq('workspace_id', ws).eq('status', 'ACTIVE').order('sort_order', { ascending: true }),
    admin().from('contractors').select('id,name').eq('workspace_id', ws).is('archived_at', null).order('name'),
  ]);
  return {
    products: (productsRes.data || []).map((p: any) => ({ id: p.id, name: p.name, default_price: Number(p.default_price) || 0 })),
    contractors: (contractorsRes.data || []).map((c: any) => ({ id: c.id, name: c.name })),
  };
}
const CATALOG_KEY = 'catalog:v1';
async function getCatalog(): Promise<Catalog> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.data;
  if (redis) {
    try {
      const cached = await redis.get<Catalog>(CATALOG_KEY);
      if (cached) { catalogCache = { at: Date.now(), data: cached }; return cached; }
    } catch (e) { console.error('REDIS_GET_CATALOG', e); }
  }
  const data = await loadCatalog();
  catalogCache = { at: Date.now(), data };
  if (redis) { try { await redis.set(CATALOG_KEY, data, { ex: CATALOG_TTL_MS / 1000 }); } catch (e) { console.error('REDIS_SET_CATALOG', e); } }
  return data;
}
async function invalidateCatalog() {
  catalogCache = null;
  if (redis) { try { await redis.del(CATALOG_KEY); } catch (e) { console.error('REDIS_DEL_CATALOG', e); } }
}

function contractorsKeyboard(contractors: CatalogContractor[], page: number): InlineButton[][] {
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(contractors.length / pageSize));
  const slice = contractors.slice(page * pageSize, page * pageSize + pageSize);
  const rows: InlineButton[][] = slice.map(c => [{ text: c.name, callback_data: `arr:c:${c.id}` }]);
  const nav: InlineButton[] = [];
  if (page > 0) nav.push({ text: '« Назад', callback_data: `arr:cp:${page - 1}` });
  if (page < pages - 1) nav.push({ text: 'Вперёд »', callback_data: `arr:cp:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '➕ Новый поставщик', callback_data: 'arr:newc' }]);
  rows.push([{ text: '❌ Отмена', callback_data: 'arr:cancel' }]);
  return rows;
}

function productsKeyboard(products: CatalogProduct[], excludeIds: string[]): InlineButton[][] {
  const list = products.filter(p => !excludeIds.includes(p.id));
  const rows: InlineButton[][] = list.map(p => [{ text: p.name, callback_data: `arr:p:${p.id}` }]);
  rows.push([{ text: '✅ Завершить приёмку', callback_data: 'arr:finish' }]);
  rows.push([{ text: '❌ Отмена', callback_data: 'arr:cancel' }]);
  return rows;
}

function cartSummary(s: Session): string {
  const items = s.items || [];
  if (!items.length) return 'Корзина пуста.';
  const lines = items.map(i => `• ${i.product_name}: ${qty(i.kg)} × ${money(i.price)} = <b>${money(i.kg * i.price)}</b>`);
  const total = items.reduce((sum, i) => sum + i.kg * i.price, 0);
  return `${lines.join('\n')}\n\nИтого: <b>${money(total)}</b>`;
}

async function showProductStep(chatId: number, s: Session) {
  const excludeIds = (s.items || []).map(i => i.product_id);
  const { products } = await getCatalog();
  const kb = productsKeyboard(products, excludeIds);
  await sendMessage(chatId, s.items?.length ? `${cartSummary(s)}\n\nВыбери следующий товар:` : 'Выбери товар:', kb);
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 401 });
  }
  const update = await req.json().catch(() => null);
  if (!update) return NextResponse.json({ ok: true });

  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message);
    }
  } catch (e: any) {
    console.error('TELEGRAM_WEBHOOK_ERROR', e);
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) await sendMessage(chatId, `⚠️ Ошибка: ${e?.message || 'что-то пошло не так'}`);
  }
  return NextResponse.json({ ok: true });
}

async function handleMessage(message: any) {
  const chatId = message.chat.id as number;
  const from = message.from;
  const telegramUserId = from.id as number;
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(telegramUserId);
  const text = String(message.text || '').trim();

  if (text === '/start') {
    await ensureRegistered(telegramUserId, from.username, displayName);
    if (await isAllowed(telegramUserId)) {
      await sendMessage(chatId, `Привет, ${displayName}! Это бот Ангара — приёмка товара и отчёт за день.`, mainMenu);
    } else {
      await requestAccess(telegramUserId, from.username, displayName);
      await sendMessage(chatId, 'Заявка на доступ отправлена владельцу. Как только подтвердят — напиши /start ещё раз.');
    }
    return;
  }

  // /отчет сразу идёт в sendReport — там RPC сама проверяет allowlist внутри
  // базы, без отдельного похода в Supabase за проверкой (экономит один
  // сетевой круг до базы, которая географически далеко от сервера).
  if (text === '/отчет' || text === '/report') { await sendReport(chatId, telegramUserId); return; }

  // Проверка доступа и чтение сессии — параллельно, а не друг за другом.
  const [allowed, s] = await Promise.all([isAllowed(telegramUserId), getSession(chatId)]);
  if (!allowed) {
    await sendMessage(chatId, '⛔ Доступ запрещён. Напиши /start, чтобы отправить заявку владельцу.');
    return;
  }

  if (text === '/menu') { await sendMessage(chatId, 'Главное меню:', mainMenu); return; }

  if (s.step === 'awaiting_contractor_name') {
    if (!text) { await sendMessage(chatId, 'Напиши название поставщика текстом.'); return; }
    const { data, error } = await admin().from('contractors').insert({ workspace_id: workspaceId(), name: text }).select('id,name').single();
    if (error) { await sendMessage(chatId, `Не получилось создать поставщика: ${error.message}`); return; }
    s.contractor_id = data.id; s.contractor_name = data.name; s.step = 'choosing_product'; s.items = s.items || [];
    await invalidateCatalog(); // список поставщиков изменился
    await Promise.all([setSession(chatId, telegramUserId, s), showProductStep(chatId, s)]);
    return;
  }

  if (s.step === 'awaiting_kg') {
    const n = parseNum(text);
    if (n === null || n <= 0) { await sendMessage(chatId, 'Нужно число больше 0. Сколько кг приняли?'); return; }
    s.pending_kg = n; s.step = 'awaiting_price';
    const def = s.pending_default_price ?? 0;
    await Promise.all([
      setSession(chatId, telegramUserId, s),
      sendMessage(chatId, `Цена за кг для «${s.pending_product_name}»? (по умолчанию ${money(def)})`, [[{ text: `Использовать ${money(def)}`, callback_data: 'arr:defprice' }]]),
    ]);
    return;
  }

  if (s.step === 'awaiting_price') {
    const n = parseNum(text);
    if (n === null || n < 0) { await sendMessage(chatId, 'Нужно число цены за кг (0 или больше).'); return; }
    finalizeItem(s, n);
    await Promise.all([setSession(chatId, telegramUserId, s), sendCart(chatId, s)]);
    return;
  }

  await sendMessage(chatId, 'Не понял. Открой меню:', mainMenu);
}

function sendCart(chatId: number, s: Session) {
  return sendMessage(chatId, cartSummary(s), [
    [{ text: '➕ Добавить ещё товар', callback_data: 'arr:more' }],
    [{ text: '✅ Завершить приёмку', callback_data: 'arr:finish' }],
    [{ text: '❌ Отмена', callback_data: 'arr:cancel' }],
  ]);
}

function finalizeItem(s: Session, price: number) {
  s.items = s.items || [];
  s.items.push({ product_id: s.pending_product_id!, product_name: s.pending_product_name!, kg: s.pending_kg!, price });
  s.step = 'cart'; s.pending_product_id = undefined; s.pending_product_name = undefined; s.pending_default_price = undefined; s.pending_kg = undefined;
}

async function sendReport(chatId: number, telegramUserId: number) {
  const { data, error } = await admin().rpc('telegram_today_summary', { p_workspace_id: workspaceId(), p_telegram_user_id: telegramUserId });
  if (error) {
    const denied = /Доступ запрещён/i.test(error.message);
    await sendMessage(chatId, denied ? '⛔ Доступ запрещён. Напиши /start, чтобы отправить заявку владельцу.' : `Не получилось получить отчёт: ${error.message}`);
    return;
  }
  const r = data as any;
  const byProduct = (r.arrivals_by_product || []) as Array<{ name: string; kg: number; sum: number }>;
  const lines = byProduct.length ? byProduct.map(p => `• ${p.name}: ${qty(p.kg)} — ${money(p.sum)}`).join('\n') : 'Пока ничего не приняли.';
  const text = `<b>Отчёт за сегодня (Ангар)</b>\n\n📥 Приход: ${r.arrivals_count} операций на ${money(r.arrivals_total)}\n${lines}\n\n📤 Отгрузка: ${r.shipments_count} операций на ${money(r.shipments_total)}`;
  await sendMessage(chatId, text, mainMenu);
}

async function handleCallback(cq: any) {
  const chatId = cq.message.chat.id as number;
  const telegramUserId = cq.from.id as number;
  const data = String(cq.data || '');
  // Не ждём подтверждение нажатия кнопки — это только убирает "часики" на
  // кнопке у пользователя, реальный ответ не должен из-за этого тормозить.
  answerCallbackQuery(cq.id).catch(() => {});

  if (data.startsWith('appr:') || data.startsWith('rej:')) {
    if (!(await isOwner(telegramUserId))) { await sendMessage(chatId, 'Только владелец может одобрять заявки.'); return; }
    const targetId = Number(data.split(':')[1]);
    const approve = data.startsWith('appr:');
    await admin().from('telegram_bot_users').update({ allowed: approve, approved_at: new Date().toISOString(), approved_by: telegramUserId }).eq('telegram_user_id', targetId);
    await sendMessage(chatId, approve ? '✅ Доступ выдан.' : '🚫 Заявка отклонена.');
    await sendMessage(targetId, approve ? 'Твою заявку одобрили! Напиши /start.' : 'Твою заявку отклонили.');
    return;
  }

  // Отчёт — сразу в sendReport, без отдельной проверки allowlist (RPC
  // проверяет её сама внутри базы, это экономит один сетевой круг).
  if (data === 'rep:today') { await sendReport(chatId, telegramUserId); return; }

  // Сессия нужна не на каждом шаге: старт, листание поставщиков, выбор
  // поставщика и отмена её не читают. Остальное читаем параллельно с проверкой доступа.
  const needsSession = !(data === 'arr:start' || data.startsWith('arr:cp:') || data === 'arr:newc' || data.startsWith('arr:c:') || data === 'arr:cancel');
  const [allowed, s] = await Promise.all([
    isAllowed(telegramUserId),
    needsSession ? getSession(chatId) : Promise.resolve<Session>({}),
  ]);
  if (!allowed) { await sendMessage(chatId, '⛔ Доступ запрещён. Напиши /start.'); return; }

  if (data === 'arr:start') {
    const [catalog] = await Promise.all([
      getCatalog(),
      setSession(chatId, telegramUserId, { step: 'choosing_contractor', items: [] }),
    ]);
    await sendMessage(chatId, 'Кто сдал товар?', contractorsKeyboard(catalog.contractors, 0));
    return;
  }

  if (data.startsWith('arr:cp:')) {
    const page = Number(data.split(':')[2]);
    const catalog = await getCatalog();
    await sendMessage(chatId, 'Кто сдал товар?', contractorsKeyboard(catalog.contractors, page));
    return;
  }

  if (data === 'arr:newc') {
    await Promise.all([
      setSession(chatId, telegramUserId, { step: 'awaiting_contractor_name', items: [] }),
      sendMessage(chatId, 'Напиши название поставщика:'),
    ]);
    return;
  }

  if (data.startsWith('arr:c:')) {
    const next: Session = { step: 'choosing_product', items: [], contractor_id: data.slice('arr:c:'.length) };
    await Promise.all([setSession(chatId, telegramUserId, next), showProductStep(chatId, next)]);
    return;
  }

  if (data === 'arr:more') {
    s.step = 'choosing_product';
    await Promise.all([setSession(chatId, telegramUserId, s), showProductStep(chatId, s)]);
    return;
  }

  if (data.startsWith('arr:p:')) {
    const productId = data.slice('arr:p:'.length);
    let p = (await getCatalog()).products.find(x => x.id === productId);
    if (!p) { await invalidateCatalog(); p = (await getCatalog()).products.find(x => x.id === productId); }
    if (!p) { await sendMessage(chatId, 'Товар не найден. Нажми «Приёмка» ещё раз.'); return; }
    s.pending_product_id = p.id; s.pending_product_name = p.name; s.pending_default_price = p.default_price;
    s.step = 'awaiting_kg';
    await Promise.all([setSession(chatId, telegramUserId, s), sendMessage(chatId, `«${p.name}» — сколько кг приняли?`)]);
    return;
  }

  if (data === 'arr:defprice') {
    if (s.step !== 'awaiting_price' || !s.pending_product_id) { await sendMessage(chatId, 'Сначала выбери товар.'); return; }
    finalizeItem(s, s.pending_default_price ?? 0);
    await Promise.all([setSession(chatId, telegramUserId, s), sendCart(chatId, s)]);
    return;
  }

  if (data === 'arr:finish') {
    if (!s.items?.length || !s.contractor_id) { await sendMessage(chatId, 'Корзина пуста — нечего проводить.'); return; }
    const { data: result, error } = await admin().rpc('telegram_post_arrival', {
      p_workspace_id: workspaceId(), p_telegram_user_id: telegramUserId, p_contractor_id: s.contractor_id,
      p_items: s.items.map(i => ({ product_id: i.product_id, kg: i.kg, price: i.price })),
    });
    if (error) { await sendMessage(chatId, `⚠️ Не удалось провести приёмку: ${error.message}`); return; }
    const r = result as any;
    await Promise.all([clearSession(chatId), sendMessage(chatId, `✅ Приёмка №${r.operation_number} проведена на ${money(r.total)}.`, mainMenu)]);
    return;
  }

  if (data === 'arr:cancel') {
    await Promise.all([clearSession(chatId), sendMessage(chatId, 'Отменено.', mainMenu)]);
    return;
  }
}
