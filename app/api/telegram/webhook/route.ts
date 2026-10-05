import { NextResponse, after } from 'next/server';
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
  edit_index?: number; // какую позицию корзины сейчас правим
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

// ── Ответы Telegram прямо в ответе вебхука ─────────────────────────────────
// Вместо отдельного запроса sendMessage к api.telegram.org обработчик возвращает
// «команду», а вебхук отдаёт её в теле ответа — Telegram выполняет её сам.
// Это экономит целый сетевой заход на каждое нажатие. Шаги по кнопкам правят
// то же сообщение (editMessageText), поэтому чат не засоряется.
type Reply = Record<string, unknown> | null;
const keyboard = (buttons?: InlineButton[][]) => ({ inline_keyboard: buttons || [] });

function sendReply(chatId: number, text: string, buttons?: InlineButton[][]): Reply {
  return { method: 'sendMessage', chat_id: chatId, text, parse_mode: 'HTML', reply_markup: buttons ? keyboard(buttons) : undefined };
}
function editReply(chatId: number, messageId: number | undefined, text: string, buttons?: InlineButton[][]): Reply {
  if (!messageId) return sendReply(chatId, text, buttons);
  return { method: 'editMessageText', chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: keyboard(buttons) };
}

const cartButtons: InlineButton[][] = [
  [{ text: '➕ Добавить ещё товар', callback_data: 'arr:more' }],
  [{ text: '✏️ Изменить / 🗑 Убрать позицию', callback_data: 'arr:edit' }],
  [{ text: '✅ Завершить приёмку', callback_data: 'arr:finish' }],
  [{ text: '❌ Отмена', callback_data: 'arr:cancel' }],
];
const cartReply = (chatId: number, s: Session, messageId?: number) => editReply(chatId, messageId, cartSummary(s), cartButtons);

async function productStep(chatId: number, s: Session, messageId?: number): Promise<Reply> {
  const excludeIds = (s.items || []).map(i => i.product_id);
  const { products } = await getCatalog();
  const text = s.items?.length ? `${cartSummary(s)}\n\nВыбери следующий товар:` : 'Выбери товар:';
  return editReply(chatId, messageId, text, productsKeyboard(products, excludeIds));
}

// GET — для прогрева функции (пингуйте раз в 5 минут, чтобы не было холодного
// старта) и быстрой проверки: какой стор используется и сколько отвечает Redis.
export const dynamic = 'force-dynamic';
export async function GET() {
  let redisMs: number | null = null;
  if (redis) {
    const t = Date.now();
    try { await redis.ping(); redisMs = Date.now() - t; } catch { redisMs = -1; }
  }
  return NextResponse.json({ ok: true, store: redis ? 'redis' : 'supabase-fallback', redisMs });
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 401 });
  }
  const update = await req.json().catch(() => null);
  if (!update) return NextResponse.json({ ok: true });

  let reply: Reply = null;
  try {
    if (update.callback_query) {
      // «Часики» на кнопке убираем уже ПОСЛЕ ответа вебхука — шаг их не ждёт.
      const cqId = String(update.callback_query.id);
      after(() => answerCallbackQuery(cqId).catch(() => {}));
      reply = await handleCallback(update.callback_query);
    } else if (update.message) {
      reply = await handleMessage(update.message);
    }
  } catch (e: any) {
    console.error('TELEGRAM_WEBHOOK_ERROR', e);
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) reply = sendReply(chatId, `⚠️ Ошибка: ${e?.message || 'что-то пошло не так'}`);
  }
  return NextResponse.json(reply ?? { ok: true });
}

async function handleMessage(message: any): Promise<Reply> {
  const chatId = message.chat.id as number;
  const from = message.from;
  const telegramUserId = from.id as number;
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(telegramUserId);
  const text = String(message.text || '').trim();

  if (text === '/start') {
    await ensureRegistered(telegramUserId, from.username, displayName);
    if (await isAllowed(telegramUserId)) {
      return sendReply(chatId, `Привет, ${displayName}! Это бот Ангара — приёмка товара и отчёт за день.`, mainMenu);
    }
    await requestAccess(telegramUserId, from.username, displayName);
    return sendReply(chatId, 'Заявка на доступ отправлена владельцу. Как только подтвердят — напиши /start ещё раз.');
  }

  // /отчет сразу идёт в sendReport — RPC сама проверяет allowlist внутри базы.
  if (text === '/отчет' || text === '/report') return sendReport(chatId, telegramUserId);

  // Проверка доступа и чтение сессии — параллельно.
  const [allowed, s] = await Promise.all([isAllowed(telegramUserId), getSession(chatId)]);
  if (!allowed) return sendReply(chatId, '⛔ Доступ запрещён. Напиши /start, чтобы отправить заявку владельцу.');

  if (text === '/menu') return sendReply(chatId, 'Главное меню:', mainMenu);

  if (s.step === 'awaiting_contractor_name') {
    if (!text) return sendReply(chatId, 'Напиши название поставщика текстом.');
    const { data, error } = await admin().from('contractors').insert({ workspace_id: workspaceId(), name: text }).select('id,name').single();
    if (error) return sendReply(chatId, `Не получилось создать поставщика: ${error.message}`);
    s.contractor_id = data.id; s.contractor_name = data.name; s.step = 'choosing_product'; s.items = s.items || [];
    await invalidateCatalog(); // список поставщиков изменился
    const [, reply] = await Promise.all([setSession(chatId, telegramUserId, s), productStep(chatId, s)]);
    return reply;
  }

  if ((s.step === 'editing_kg' || s.step === 'editing_price') && s.edit_index !== undefined) {
    const item = s.items?.[s.edit_index];
    if (!item) { s.step = 'cart'; s.edit_index = undefined; await setSession(chatId, telegramUserId, s); return cartReply(chatId, s); }
    const n = parseNum(text);
    if (s.step === 'editing_kg') {
      if (n === null || n <= 0) return sendReply(chatId, 'Нужно число больше 0. Сколько кг?');
      item.kg = n;
    } else {
      if (n === null || n < 0) return sendReply(chatId, 'Нужно число цены за кг (0 или больше).');
      item.price = n;
    }
    s.step = 'cart'; s.edit_index = undefined;
    await setSession(chatId, telegramUserId, s);
    return cartReply(chatId, s);
  }

  if (s.step === 'awaiting_kg') {
    const n = parseNum(text);
    if (n === null || n <= 0) return sendReply(chatId, 'Нужно число больше 0. Сколько кг приняли?');
    s.pending_kg = n; s.step = 'awaiting_price';
    await setSession(chatId, telegramUserId, s);
    const def = s.pending_default_price ?? 0;
    return sendReply(chatId, `Цена за кг для «${s.pending_product_name}»? (по умолчанию ${money(def)})`, [[{ text: `Использовать ${money(def)}`, callback_data: 'arr:defprice' }]]);
  }

  if (s.step === 'awaiting_price') {
    const n = parseNum(text);
    if (n === null || n < 0) return sendReply(chatId, 'Нужно число цены за кг (0 или больше).');
    finalizeItem(s, n);
    await setSession(chatId, telegramUserId, s);
    return cartReply(chatId, s);
  }

  return sendReply(chatId, 'Не понял. Открой меню:', mainMenu);
}

function finalizeItem(s: Session, price: number) {
  s.items = s.items || [];
  s.items.push({ product_id: s.pending_product_id!, product_name: s.pending_product_name!, kg: s.pending_kg!, price });
  s.step = 'cart'; s.pending_product_id = undefined; s.pending_product_name = undefined; s.pending_default_price = undefined; s.pending_kg = undefined;
}

async function sendReport(chatId: number, telegramUserId: number, messageId?: number): Promise<Reply> {
  const { data, error } = await admin().rpc('telegram_today_summary', { p_workspace_id: workspaceId(), p_telegram_user_id: telegramUserId });
  if (error) {
    const denied = /Доступ запрещён/i.test(error.message);
    return sendReply(chatId, denied ? '⛔ Доступ запрещён. Напиши /start, чтобы отправить заявку владельцу.' : `Не получилось получить отчёт: ${error.message}`);
  }
  const r = data as any;
  const byProduct = (r.arrivals_by_product || []) as Array<{ name: string; kg: number; sum: number }>;
  const lines = byProduct.length ? byProduct.map(p => `• ${p.name}: ${qty(p.kg)} — ${money(p.sum)}`).join('\n') : 'Пока ничего не приняли.';
  const text = `<b>Отчёт за сегодня (Ангар)</b>\n\n📥 Приход: ${r.arrivals_count} операций на ${money(r.arrivals_total)}\n${lines}\n\n📤 Отгрузка: ${r.shipments_count} операций на ${money(r.shipments_total)}`;
  return editReply(chatId, messageId, text, mainMenu);
}

async function handleCallback(cq: any): Promise<Reply> {
  const chatId = cq.message.chat.id as number;
  const messageId = cq.message.message_id as number | undefined;
  const telegramUserId = cq.from.id as number;
  const data = String(cq.data || '');

  if (data.startsWith('appr:') || data.startsWith('rej:')) {
    if (!(await isOwner(telegramUserId))) return sendReply(chatId, 'Только владелец может одобрять заявки.');
    const targetId = Number(data.split(':')[1]);
    const approve = data.startsWith('appr:');
    await admin().from('telegram_bot_users').update({ allowed: approve, approved_at: new Date().toISOString(), approved_by: telegramUserId }).eq('telegram_user_id', targetId);
    await sendMessage(targetId, approve ? 'Твою заявку одобрили! Напиши /start.' : 'Твою заявку отклонили.');
    return editReply(chatId, messageId, approve ? '✅ Доступ выдан.' : '🚫 Заявка отклонена.');
  }

  // Отчёт — сразу в sendReport, без отдельной проверки allowlist (RPC
  // проверяет её сама внутри базы).
  if (data === 'rep:today') return sendReport(chatId, telegramUserId, messageId);

  // Сессия нужна не на каждом шаге: старт, листание поставщиков, выбор
  // поставщика и отмена её не читают. Остальное читаем параллельно с проверкой доступа.
  const needsSession = !(data === 'arr:start' || data.startsWith('arr:cp:') || data === 'arr:newc' || data.startsWith('arr:c:') || data === 'arr:cancel');
  const [allowed, s] = await Promise.all([
    isAllowed(telegramUserId),
    needsSession ? getSession(chatId) : Promise.resolve<Session>({}),
  ]);
  if (!allowed) return sendReply(chatId, '⛔ Доступ запрещён. Напиши /start.');

  if (data === 'arr:start') {
    const [catalog] = await Promise.all([
      getCatalog(),
      setSession(chatId, telegramUserId, { step: 'choosing_contractor', items: [] }),
    ]);
    return editReply(chatId, messageId, 'Кто сдал товар?', contractorsKeyboard(catalog.contractors, 0));
  }

  if (data.startsWith('arr:cp:')) {
    const page = Number(data.split(':')[2]);
    const catalog = await getCatalog();
    return editReply(chatId, messageId, 'Кто сдал товар?', contractorsKeyboard(catalog.contractors, page));
  }

  if (data === 'arr:newc') {
    await setSession(chatId, telegramUserId, { step: 'awaiting_contractor_name', items: [] });
    return editReply(chatId, messageId, 'Напиши название поставщика:');
  }

  if (data.startsWith('arr:c:')) {
    const next: Session = { step: 'choosing_product', items: [], contractor_id: data.slice('arr:c:'.length) };
    const [, reply] = await Promise.all([setSession(chatId, telegramUserId, next), productStep(chatId, next, messageId)]);
    return reply;
  }

  if (data === 'arr:more') {
    s.step = 'choosing_product';
    const [, reply] = await Promise.all([setSession(chatId, telegramUserId, s), productStep(chatId, s, messageId)]);
    return reply;
  }

  if (data.startsWith('arr:p:')) {
    const productId = data.slice('arr:p:'.length);
    let p = (await getCatalog()).products.find(x => x.id === productId);
    if (!p) { await invalidateCatalog(); p = (await getCatalog()).products.find(x => x.id === productId); }
    if (!p) return sendReply(chatId, 'Товар не найден. Нажми «Приёмка» ещё раз.');
    s.pending_product_id = p.id; s.pending_product_name = p.name; s.pending_default_price = p.default_price;
    s.step = 'awaiting_kg';
    await setSession(chatId, telegramUserId, s);
    return editReply(chatId, messageId, `«${p.name}» — сколько кг приняли?`, [[{ text: '↩️ Другой товар', callback_data: 'arr:more' }]]);
  }

  if (data === 'arr:defprice') {
    if (s.step !== 'awaiting_price' || !s.pending_product_id) return sendReply(chatId, 'Сначала выбери товар.');
    finalizeItem(s, s.pending_default_price ?? 0);
    await setSession(chatId, telegramUserId, s);
    return cartReply(chatId, s, messageId);
  }

  // ── Правка корзины: выбрать позицию → кг / цена / убрать ────────────────
  if (data === 'arr:back') {
    s.step = 'cart'; s.edit_index = undefined;
    await setSession(chatId, telegramUserId, s);
    return cartReply(chatId, s, messageId);
  }

  if (data === 'arr:edit') {
    const items = s.items || [];
    if (!items.length) return sendReply(chatId, 'Корзина пуста.');
    const rows: InlineButton[][] = items.map((it, i) => [{ text: `${i + 1}. ${it.product_name} · ${qty(it.kg)} × ${money(it.price)}`, callback_data: `arr:ei:${i}` }]);
    rows.push([{ text: '← Назад к корзине', callback_data: 'arr:back' }]);
    return editReply(chatId, messageId, 'Какую позицию изменить?', rows);
  }

  const editMatch = data.match(/^arr:(ei|ek|ep|ed):(\d+)$/);
  if (editMatch) {
    const idx = Number(editMatch[2]);
    const item = s.items?.[idx];
    if (!item) return cartReply(chatId, s, messageId); // позиции уже нет — просто показываем корзину
    const action = editMatch[1];

    if (action === 'ei') {
      return editReply(chatId, messageId, `«${item.product_name}»: ${qty(item.kg)} × ${money(item.price)} = <b>${money(item.kg * item.price)}</b>\n\nЧто изменить?`, [
        [{ text: '⚖️ Кг', callback_data: `arr:ek:${idx}` }, { text: '💰 Цена', callback_data: `arr:ep:${idx}` }],
        [{ text: '🗑 Убрать позицию', callback_data: `arr:ed:${idx}` }],
        [{ text: '← Назад', callback_data: 'arr:edit' }],
      ]);
    }
    if (action === 'ek' || action === 'ep') {
      s.step = action === 'ek' ? 'editing_kg' : 'editing_price'; s.edit_index = idx;
      await setSession(chatId, telegramUserId, s);
      const prompt = action === 'ek' ? `«${item.product_name}» — сколько кг? (сейчас ${qty(item.kg)})` : `«${item.product_name}» — цена за кг? (сейчас ${money(item.price)})`;
      return editReply(chatId, messageId, prompt, [[{ text: '← Отмена', callback_data: 'arr:back' }]]);
    }
    // ed — убрать позицию
    s.items!.splice(idx, 1); s.edit_index = undefined;
    if (!s.items!.length) {
      s.step = 'choosing_product';
      const [, reply] = await Promise.all([setSession(chatId, telegramUserId, s), productStep(chatId, s, messageId)]);
      return reply;
    }
    s.step = 'cart';
    await setSession(chatId, telegramUserId, s);
    return cartReply(chatId, s, messageId);
  }

  if (data === 'arr:finish') {
    if (!s.items?.length || !s.contractor_id) return sendReply(chatId, 'Корзина пуста — нечего проводить.');
    const { data: result, error } = await admin().rpc('telegram_post_arrival', {
      p_workspace_id: workspaceId(), p_telegram_user_id: telegramUserId, p_contractor_id: s.contractor_id,
      p_items: s.items.map(i => ({ product_id: i.product_id, kg: i.kg, price: i.price })),
    });
    if (error) return sendReply(chatId, `⚠️ Не удалось провести приёмку: ${error.message}`);
    const r = result as any;
    await clearSession(chatId);
    return editReply(chatId, messageId, `✅ Приёмка №${r.operation_number} проведена на ${money(r.total)}.\n\n${cartSummary(s)}`, mainMenu);
  }

  if (data === 'arr:cancel') {
    await clearSession(chatId);
    return editReply(chatId, messageId, 'Отменено.', mainMenu);
  }

  return null;
}
