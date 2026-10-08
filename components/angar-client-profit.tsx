'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createClient } from '@/lib/supabase/client';
import { CountUp } from './point-report-shell';

// Ангар → «Прибыль клиентов». Отвечает на вопрос владельца: с каких клиентов я хорошо зарабатываю.
//  • Покупатели (кому отгружаю): реальная прибыль = выручка − себестоимость.
//  • Поставщики (у кого принимаю): оценка. Себестоимость идёт «по средней», без привязки к партии, поэтому
//    прибыль с поставщика считаем приблизительно: «ожидаемая прибыль» (если металл продать по средней цене продажи)
//    и «выгода от цены» (дешевле или дороже средней закупочной цены по тем же металлам).

type BuyerMetal = { product: string; kg: number; revenue: number; cogs: number; avg_sale: number; premium: number };
type Buyer = { id: string; name: string; group_id: string | null; group: string | null; revenue: number; cogs: number; profit: number; kg: number; premium: number; ops: number; metals: BuyerMetal[] };
type SupMetal = { product: string; kg: number; spent: number; avg_buy: number; avg_sale: number | null; saving: number; exp_profit: number | null };
type Supplier = { id: string; name: string; group_id: string | null; group: string | null; spent: number; kg: number; saving: number; exp_profit: number | null; assessed: number; ops: number; metals: SupMetal[] };
type Data = { totals: { in_sum: number; in_kg: number; out_sum: number; out_kg: number; cogs: number }; buyers: Buyer[]; suppliers: Supplier[] };

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const rub = (v: number) => nf0.format(Math.round(v)) + ' ₸';
const compact = (v: number) => { const a = Math.abs(v); const s = a >= 1e6 ? `${nf1.format(a / 1e6)} млн` : a >= 1e3 ? `${nf0.format(a / 1e3)} тыс` : nf0.format(a); return (v < 0 ? '−' : '') + s + ' ₸'; };
const signed = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + compact(Math.abs(v)).replace(/^−/, '');
const price = (v: number) => (v >= 1000 ? nf0 : nf1).format(v) + ' ₸/кг';
const kgf = (v: number) => nf0.format(v) + ' кг';
const pc = (v: number) => nf1.format(v) + '%';
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const plural = (k: number, one: string, few: string, many: string) => { const a = Math.abs(k) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
const diffTxt = (d: number, goodWhenPositive = true) => (Math.abs(d) < 0.05 ? '0' : `${d > 0 ? '+' : '−'}${nf1.format(Math.abs(d))}`);
const pad = (v: number) => String(v).padStart(2, '0');
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

type BRow = { key: string; name: string; members: string[]; single: boolean; revenue: number; cogs: number; profit: number; kg: number; premium: number; ops: number; margin: number; perKg: number; metals: BuyerMetal[] };
type SRow = { key: string; name: string; members: string[]; single: boolean; spent: number; kg: number; saving: number; exp: number; assessedShare: number; ops: number; metals: SupMetal[] };

function mergeBuyers(list: Buyer[], merge: boolean): BRow[] {
  const map = new Map<string, BRow>();
  list.forEach((b) => {
    const grouped = merge && !!b.group_id;
    const key = grouped ? `g:${b.group_id}` : `c:${b.id}`;
    const cur = map.get(key) || { key, name: grouped ? (b.group || b.name) : b.name, members: [], single: !grouped, revenue: 0, cogs: 0, profit: 0, kg: 0, premium: 0, ops: 0, margin: 0, perKg: 0, metals: [] };
    cur.members.push(b.name); cur.revenue += n(b.revenue); cur.cogs += n(b.cogs); cur.kg += n(b.kg); cur.premium += n(b.premium); cur.ops += n(b.ops);
    b.metals.forEach((m) => {
      const ex = cur.metals.find((x) => x.product === m.product);
      if (ex) { ex.kg += n(m.kg); ex.revenue += n(m.revenue); ex.cogs += n(m.cogs); ex.premium += n(m.premium); }
      else cur.metals.push({ product: m.product, kg: n(m.kg), revenue: n(m.revenue), cogs: n(m.cogs), avg_sale: n(m.avg_sale), premium: n(m.premium) });
    });
    map.set(key, cur);
  });
  return [...map.values()].map((r) => ({ ...r, profit: r.revenue - r.cogs, margin: r.revenue > 0 ? ((r.revenue - r.cogs) / r.revenue) * 100 : 0, perKg: r.kg > 0 ? (r.revenue - r.cogs) / r.kg : 0, metals: r.metals.sort((a, b) => b.revenue - a.revenue) }))
    .sort((a, b) => b.profit - a.profit);
}
function mergeSuppliers(list: Supplier[], merge: boolean): SRow[] {
  const map = new Map<string, SRow & { assessed: number }>();
  list.forEach((s) => {
    const grouped = merge && !!s.group_id;
    const key = grouped ? `g:${s.group_id}` : `c:${s.id}`;
    const cur = map.get(key) || { key, name: grouped ? (s.group || s.name) : s.name, members: [], single: !grouped, spent: 0, kg: 0, saving: 0, exp: 0, assessedShare: 0, assessed: 0, ops: 0, metals: [] };
    cur.members.push(s.name); cur.spent += n(s.spent); cur.kg += n(s.kg); cur.saving += n(s.saving); cur.exp += n(s.exp_profit); cur.assessed += n(s.assessed); cur.ops += n(s.ops);
    s.metals.forEach((m) => {
      const ex = cur.metals.find((x) => x.product === m.product);
      if (ex) { ex.kg += n(m.kg); ex.spent += n(m.spent); ex.saving += n(m.saving); ex.exp_profit = m.exp_profit == null ? ex.exp_profit : n(ex.exp_profit) + n(m.exp_profit); }
      else cur.metals.push({ product: m.product, kg: n(m.kg), spent: n(m.spent), avg_buy: n(m.avg_buy), avg_sale: m.avg_sale == null ? null : n(m.avg_sale), saving: n(m.saving), exp_profit: m.exp_profit == null ? null : n(m.exp_profit) });
    });
    map.set(key, cur);
  });
  return [...map.values()].map((r) => ({ ...r, assessedShare: r.spent > 0 ? (r.assessed / r.spent) * 100 : 0, metals: r.metals.sort((a, b) => b.spent - a.spent) })).sort((a, b) => b.spent - a.spent);
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const update = () => setW(Math.floor(el.getBoundingClientRect().width));
    update();
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const Line = ({ l, v }: { l: string; v: ReactNode }) => <div className="mm-line"><span>{l}</span><b>{v}</b></div>;

/* ── график «объём и маржа» ── */
function Bubbles({ rows, avgMargin, sel, onSel }: { rows: BRow[]; avgMargin: number; sel: string | null; onSel: (k: string) => void }) {
  const [ref, w] = useWidth();
  const [tip, setTip] = useState<{ x: number; y: number; r: BRow } | null>(null);
  const H = 300, M = { l: 46, r: 16, t: 16, b: 34 };
  const maxRev = Math.max(1, ...rows.map((r) => r.revenue)) * 1.12;
  const margins = rows.map((r) => r.margin);
  const lo = Math.min(0, ...margins, avgMargin) - 1, hi = Math.max(...margins, avgMargin) + 2;
  const pw = Math.max(10, w - M.l - M.r), ph = H - M.t - M.b;
  const x = (v: number) => M.l + (v / maxRev) * pw;
  const y = (v: number) => M.t + ph - ((v - lo) / (hi - lo)) * ph;
  const maxP = Math.max(1, ...rows.map((r) => Math.abs(r.profit)));
  const rad = (p: number) => 7 + Math.sqrt(Math.abs(p) / maxP) * 20;
  const ticksX = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxRev);
  const stepY = (hi - lo) > 12 ? 4 : 2;
  const ticksY: number[] = []; for (let v = Math.ceil(lo / stepY) * stepY; v <= hi; v += stepY) ticksY.push(v);
  return (
    <div className="cp-chart" ref={ref} data-noswipe>
      {w > 0 && (
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label="Объём продаж и маржа по покупателям">
          {ticksY.map((t) => <g key={t}><line x1={M.l} x2={w - M.r} y1={y(t)} y2={y(t)} stroke="#e1e4d5" /><text x={M.l - 8} y={y(t) + 3.5} textAnchor="end" className="pc-ax">{nf0.format(t)}%</text></g>)}
          {ticksX.map((t, i) => <text key={i} x={x(t)} y={H - 12} textAnchor={i === 0 ? 'start' : i === ticksX.length - 1 ? 'end' : 'middle'} className="pc-ax">{t === 0 ? '0' : compact(t).replace(' ₸', '')}</text>)}
          <line x1={M.l} x2={w - M.r} y1={y(avgMargin)} y2={y(avgMargin)} stroke="#8d8a78" strokeWidth={1.3} strokeDasharray="5 4" />
          <text x={w - M.r - 4} y={y(avgMargin) - 6} textAnchor="end" className="pc-avg">средняя маржа {pc(avgMargin)}</text>
          {[...rows].sort((a, b) => b.profit - a.profit).reverse().map((r, i) => {
            const good = r.profit < 0 ? false : r.margin >= avgMargin;
            const color = r.profit < 0 ? '#a44731' : good ? '#3e7b5d' : '#c9822f';
            const on = sel === r.key;
            return (
              <g key={r.key} className="cp-bub" style={{ animationDelay: `${Math.min(i * 60, 500)}ms` }}
                onMouseEnter={(e) => setTip({ x: x(r.revenue), y: y(r.margin) - rad(r.profit), r })} onMouseLeave={() => setTip(null)} onClick={() => onSel(r.key)}>
                <circle cx={x(r.revenue)} cy={y(r.margin)} r={rad(r.profit)} fill={color} fillOpacity={on ? 0.9 : 0.55} stroke={color} strokeWidth={on ? 3 : 1.5} />
                {(rad(r.profit) > 13 || on) && <text x={x(r.revenue)} y={y(r.margin) + 4} textAnchor="middle" className="cp-bub-t">{r.name.length > 12 ? r.name.slice(0, 11) + '…' : r.name}</text>}
              </g>
            );
          })}
        </svg>
      )}
      {tip && w > 0 && (
        <div className="pc-tip" style={{ left: Math.min(Math.max(tip.x, 90), Math.max(90, w - 90)), top: Math.max(0, tip.y - 96) }}>
          <div className="d">{tip.r.name}</div>
          <div><span>Выручка</span><b>{rub(tip.r.revenue)}</b></div>
          <div><span>Прибыль</span><b>{rub(tip.r.profit)}</b></div>
          <div><span>Маржа</span><b>{pc(tip.r.margin)}</b></div>
        </div>
      )}
      <div className="cp-axis-note"><span>← меньше оборот</span><span>больше оборот →</span></div>
    </div>
  );
}

export default function ClientProfit({ onClient }: { onClient?: (name: string) => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [preset, setPreset] = useState<'all' | '30' | '7' | 'custom'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [side, setSide] = useState<'buyers' | 'suppliers'>('buyers');
  const [merge, setMerge] = useState(true);
  const [bm, setBm] = useState<'profit' | 'margin' | 'perkg'>('profit');
  const [sm, setSm] = useState<'spent' | 'saving' | 'exp'>('spent');
  const [sel, setSel] = useState<string | null>(null);

  const range = useMemo(() => {
    const now = new Date();
    if (preset === 'all') return { f: null as string | null, t: null as string | null };
    if (preset === '30') return { f: isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), t: isoDate(now) };
    if (preset === '7') return { f: isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)), t: isoDate(now) };
    return { f: from || null, t: to || null };
  }, [preset, from, to]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setErr('');
      const { data: d, error } = await supabase.rpc('get_client_profit', { p_from: range.f, p_to: range.t });
      if (!alive) return;
      setLoading(false);
      if (error) { setErr(error.message); setData(null); return; }
      setData(d as Data);
    })();
    return () => { alive = false; };
  }, [supabase, range.f, range.t]);

  const buyers = useMemo(() => mergeBuyers(data?.buyers || [], merge), [data, merge]);
  const suppliers = useMemo(() => mergeSuppliers(data?.suppliers || [], merge), [data, merge]);
  const totalProfit = buyers.reduce((a, r) => a + r.profit, 0), totalRev = buyers.reduce((a, r) => a + r.revenue, 0);
  const avgMargin = totalRev > 0 ? (totalProfit / totalRev) * 100 : 0;
  const spentTotal = suppliers.reduce((a, r) => a + r.spent, 0), expTotal = suppliers.reduce((a, r) => a + r.exp, 0), savingTotal = suppliers.reduce((a, r) => a + r.saving, 0);

  // ── выводы ──
  const insights: Array<{ icon: string; tone: 'ok' | 'warn' | 'info'; text: ReactNode }> = [];
  if (side === 'buyers' && buyers.length) {
    const top = buyers[0];
    insights.push({ icon: '💎', tone: 'ok', text: <>Больше всего прибыли приносит <b>{top.name}</b>: {compact(top.profit)} — это {pc((top.profit / Math.max(1, totalProfit)) * 100)} всей прибыли (выручка {compact(top.revenue)}, маржа {pc(top.margin)}).</> });
    const big = buyers.filter((r) => r.revenue >= totalRev * 0.03);
    const best = [...big].sort((a, b) => b.margin - a.margin)[0], worst = [...big].sort((a, b) => a.margin - b.margin)[0];
    if (best && worst && best !== worst) insights.push({ icon: '📈', tone: 'info', text: <>Самая высокая маржа среди крупных — у <b>{best.name}</b> ({pc(best.margin)}), самая низкая — у <b>{worst.name}</b> ({pc(worst.margin)}) при общей средней {pc(avgMargin)}.</> });
    const lost = big.filter((r) => r.margin < avgMargin - 0.5).map((r) => ({ r, lost: ((avgMargin - r.margin) / 100) * r.revenue })).sort((a, b) => b.lost - a.lost)[0];
    if (lost) insights.push({ icon: '⚠️', tone: 'warn', text: <>С <b>{lost.r.name}</b> оборот большой ({compact(lost.r.revenue)}), а маржа ниже средней. Если бы зарабатывали как в среднем ({pc(avgMargin)}), было бы больше примерно на <b>{compact(lost.lost)}</b>.</> });
    const pay = [...buyers].filter((r) => r.revenue >= totalRev * 0.03).sort((a, b) => a.premium - b.premium)[0];
    if (pay && pay.premium < -200000) insights.push({ icon: '🏷️', tone: 'warn', text: <><b>{pay.name}</b> платит за те же металлы дешевле средней цены продажи — недобор около {compact(Math.abs(pay.premium))} за период.</> });
  }
  if (side === 'suppliers' && suppliers.length) {
    const top = suppliers[0];
    insights.push({ icon: '📦', tone: 'info', text: <>Больше всего закупаете у <b>{top.name}</b>: {compact(top.spent)} — {pc((top.spent / Math.max(1, spentTotal)) * 100)} всего закупа.</> });
    const big = suppliers.filter((r) => r.spent >= spentTotal * 0.03);
    const cheap = [...big].sort((a, b) => b.saving - a.saving)[0], dear = [...big].sort((a, b) => a.saving - b.saving)[0];
    if (cheap && cheap.saving > 0) insights.push({ icon: '✅', tone: 'ok', text: <>Выгоднее всего по цене — <b>{cheap.name}</b>: по тем же металлам у него дешевле средней закупочной цены, экономия около {compact(cheap.saving)}.</> });
    if (dear && dear.saving < 0 && dear !== cheap) insights.push({ icon: '⚠️', tone: 'warn', text: <>Дороже всего обходится <b>{dear.name}</b>: переплата относительно средней цены закупа около {compact(Math.abs(dear.saving))}. Стоит обсудить цену.</> });
    const best = [...suppliers].sort((a, b) => b.exp - a.exp)[0];
    if (best) insights.push({ icon: '💎', tone: 'info', text: <>Больше всего ожидаемой прибыли даёт металл от <b>{best.name}</b>: около {compact(best.exp)} (если продать по средним ценам продажи). Это оценка, а не факт.</> });
  }

  // ── строки списка ──
  const bVal = (r: BRow) => (bm === 'profit' ? r.profit : bm === 'margin' ? r.margin : r.perKg);
  const bSorted = [...buyers].sort((a, b) => bVal(b) - bVal(a));
  const bMax = Math.max(1, ...bSorted.map((r) => Math.abs(bVal(r))));
  const sVal = (r: SRow) => (sm === 'spent' ? r.spent : sm === 'saving' ? r.saving : r.exp);
  const sSorted = [...suppliers].sort((a, b) => sVal(b) - sVal(a));
  const sMax = Math.max(1, ...sSorted.map((r) => Math.abs(sVal(r))));

  const toggle = (k: string) => setSel(sel === k ? null : k);

  return (
    <section className="cp">
      <div className="cp-top">
        <div>
          <h2 className="page-title">Прибыль клиентов</h2>
          <div className="muted">Кто приносит деньги. Клиенты, которым вы продаёте, — реальная прибыль с продаж. Поставщики — оценка.</div>
        </div>
        <div className="cp-ctl">
          <div className="pc-seg">
            {([['all', 'Всё время'], ['30', '30 дней'], ['7', '7 дней'], ['custom', 'Свой период']] as const).map(([k, l]) => <button key={k} type="button" className={preset === k ? 'on' : ''} onClick={() => setPreset(k)}>{l}</button>)}
          </div>
          {preset === 'custom' && <div className="cp-dates"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><span>—</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>}
        </div>
      </div>

      {err && <div className="notice">{err}</div>}
      {loading && !data && <div className="empty-state compact">Считаю…</div>}

      {data && (
        <>
          <div className="mm-strip">
            <div className="mm-stat"><small>Прибыль (реальная)</small><b className={totalProfit < 0 ? 'neg' : ''}><CountUp value={totalProfit} format={rub} /></b><small>с продаж за период</small></div>
            <div className="mm-stat"><small>Выручка от продаж</small><b><CountUp value={totalRev} format={rub} /></b><small>{kgf(n(data.totals.out_kg))} продано</small></div>
            <div className="mm-stat"><small>Средняя маржа</small><b><CountUp value={avgMargin} format={(v) => pc(v)} /></b><small>{rub(totalProfit / Math.max(1, n(data.totals.out_kg)))} прибыли на кг</small></div>
            <div className="mm-stat"><small>Закуплено</small><b><CountUp value={n(data.totals.in_sum)} format={rub} /></b><small>{kgf(n(data.totals.in_kg))} принято</small></div>
          </div>

          <div className="cp-bar">
            <div className="pc-seg">
              <button type="button" className={side === 'buyers' ? 'on' : ''} onClick={() => { setSide('buyers'); setSel(null); }}>Покупатели · кому продаю</button>
              <button type="button" className={side === 'suppliers' ? 'on' : ''} onClick={() => { setSide('suppliers'); setSel(null); }}>Поставщики · у кого закупаю</button>
            </div>
            <button type="button" className={`pv-chip${merge ? '' : ' off'}`} onClick={() => setMerge(!merge)} title="Объединять контрагентов одной группы (например, все «Димаш»)"><span>Объединять группы</span><b>{merge ? 'да' : 'нет'}</b></button>
          </div>

          <div className="mm-insights">{insights.map((x, i) => <div key={i} className={`mm-ins ${x.tone}`} style={{ animationDelay: `${i * 70}ms` }}><span>{x.icon}</span><p>{x.text}</p></div>)}</div>

          {side === 'buyers' ? (
            !buyers.length ? <div className="empty-state compact">За период не было продаж.</div> : (
              <div className="cp-cols">
                <div className="cp-left">
                  <div className="mm-ph"><b>Объём и маржа</b><span>размер круга — прибыль · зелёный — выше средней маржи</span></div>
                  <Bubbles rows={buyers} avgMargin={avgMargin} sel={sel} onSel={toggle} />
                </div>
                <div className="cp-right">
                  <div className="mm-ph"><b>Покупатели по прибыли</b>
                    <div className="pc-seg"><button type="button" className={bm === 'profit' ? 'on' : ''} onClick={() => setBm('profit')}>Прибыль ₸</button><button type="button" className={bm === 'margin' ? 'on' : ''} onClick={() => setBm('margin')}>Маржа %</button><button type="button" className={bm === 'perkg' ? 'on' : ''} onClick={() => setBm('perkg')}>₸ за кг</button></div>
                  </div>
                  <div className="mm-list cp-list" data-noswipe>
                    {bSorted.map((r, i) => {
                      const open = sel === r.key, diff = r.margin - avgMargin;
                      return (
                        <div key={r.key} className={`mm-item${open ? ' open' : ''}`}>
                          <button type="button" className="mm-row" onClick={() => toggle(r.key)}>
                            <span className="mm-name"><i style={{ background: `hsl(${hue(r.name)} 50% 55%)` }} /><b>{r.name}</b><small>{compact(r.revenue)} выручка · маржа {pc(r.margin)}{r.members.length > 1 ? ` · ${r.members.length} ${plural(r.members.length, 'контрагент', 'контрагента', 'контрагентов')}` : ''}</small></span>
                            <span className="mm-bar"><span style={{ width: `${Math.max(2, (Math.abs(bVal(r)) / bMax) * 100)}%`, background: r.profit < 0 ? '#a44731' : diff >= 0 ? '#3e7b5d' : '#c9822f', animationDelay: `${Math.min(i * 40, 500)}ms` }} /></span>
                            <span className="mm-val"><b>{bm === 'profit' ? compact(r.profit) : bm === 'margin' ? pc(r.margin) : `${nf0.format(r.perKg)} ₸/кг`}</b><em className={Math.abs(diff) >= 1 ? (diff >= 0 ? 'ok' : 'warn') : ''}>{Math.abs(diff) < 1 ? 'как в среднем' : diff >= 0 ? 'выше среднего' : 'ниже среднего'}</em></span>
                          </button>
                          {open && (
                            <div className="mm-detail">
                              <Line l="Выручка / себестоимость" v={`${rub(r.revenue)} / ${rub(r.cogs)}`} />
                              <Line l="Прибыль" v={`${rub(r.profit)} · маржа ${pc(r.margin)} · ${nf0.format(r.perKg)} ₸ с кг`} />
                              <Line l="Продано" v={`${kgf(r.kg)} · ${r.ops} ${plural(r.ops, 'продажа', 'продажи', 'продаж')}`} />
                              <Line l="Цены против средних" v={Math.abs(r.premium) < 1 ? 'платит на уровне средней цены продажи' : <span className={r.premium >= 0 ? 'cp-good' : 'cp-bad'}>{r.premium >= 0 ? 'платит выше средней цены продажи на' : 'платит ниже средней цены продажи на'} {compact(Math.abs(r.premium))}</span>} />
                              {diff < -0.5 && <Line l="До средней маржи" v={<span className="cp-bad">недозаработано ≈ {compact(((avgMargin - r.margin) / 100) * r.revenue)}</span>} />}
                              <div className="cp-tbl-wrap"><table className="cp-tbl"><thead><tr><th>Металл</th><th>кг</th><th>Цена клиента</th><th>Средняя цена</th><th>Разница</th><th>Прибыль</th></tr></thead>
                                <tbody>{r.metals.map((m) => { const p = m.kg > 0 ? m.revenue / m.kg : 0, d = p - m.avg_sale; return (
                                  <tr key={m.product}><td>{m.product}</td><td>{nf0.format(m.kg)}</td><td>{nf1.format(p)}</td><td>{nf1.format(m.avg_sale)}</td><td className={d >= 0 ? 'cp-good' : 'cp-bad'}>{diffTxt(d)}</td><td className={m.revenue - m.cogs >= 0 ? '' : 'cp-bad'}>{compact(m.revenue - m.cogs)}</td></tr>); })}</tbody></table></div>
                              {r.single && onClient && <button type="button" className="pay-link" onClick={() => onClient(r.name)}>Открыть карточку клиента →</button>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )
          ) : (
            !suppliers.length ? <div className="empty-state compact">За период не было приходов.</div> : (
              <div>
                <div className="mm-ph"><b>Поставщики</b>
                  <div className="pc-seg"><button type="button" className={sm === 'spent' ? 'on' : ''} onClick={() => setSm('spent')}>Закуплено ₸</button><button type="button" className={sm === 'saving' ? 'on' : ''} onClick={() => setSm('saving')}>Выгода от цены</button><button type="button" className={sm === 'exp' ? 'on' : ''} onClick={() => setSm('exp')}>Ожидаемая прибыль</button></div>
                </div>
                <p className="pv-hint cp-note">Прибыль с поставщика в учёте не хранится (себестоимость идёт «по средней»), поэтому это оценка. <b>Выгода от цены</b> — дешевле или дороже средней закупочной цены по тем же металлам. <b>Ожидаемая прибыль</b> — если металл от поставщика продать по средней цене продажи. Итого по всем: выгода {signed(savingTotal)}, ожидаемая прибыль {compact(expTotal)}.</p>
                <div className="mm-list cp-list" data-noswipe>
                  {sSorted.map((r, i) => {
                    const open = sel === r.key;
                    return (
                      <div key={r.key} className={`mm-item${open ? ' open' : ''}`}>
                        <button type="button" className="mm-row" onClick={() => toggle(r.key)}>
                          <span className="mm-name"><i style={{ background: `hsl(${hue(r.name)} 50% 55%)` }} /><b>{r.name}</b><small>{compact(r.spent)} · {kgf(r.kg)} · {price(r.spent / Math.max(1, r.kg))}{r.members.length > 1 ? ` · ${r.members.length} ${plural(r.members.length, 'контрагент', 'контрагента', 'контрагентов')}` : ''}</small></span>
                          <span className="mm-bar"><span style={{ width: `${Math.max(2, (Math.abs(sVal(r)) / sMax) * 100)}%`, background: sm === 'spent' ? '#6f86b8' : sVal(r) >= 0 ? '#3e7b5d' : '#c9822f', animationDelay: `${Math.min(i * 40, 500)}ms` }} /></span>
                          <span className="mm-val"><b>{sm === 'spent' ? compact(r.spent) : sm === 'saving' ? signed(r.saving) : compact(r.exp)}</b><em className={r.saving >= 0 ? 'ok' : 'warn'}>{r.saving >= 0 ? 'дешевле среднего' : 'дороже среднего'}</em></span>
                        </button>
                        {open && (
                          <div className="mm-detail">
                            <Line l="Закуплено" v={`${kgf(r.kg)} на ${rub(r.spent)} · ${r.ops} ${plural(r.ops, 'приход', 'прихода', 'приходов')} · в среднем ${price(r.spent / Math.max(1, r.kg))}`} />
                            <Line l="Выгода от цены" v={Math.abs(r.saving) < 1 ? 'на уровне средней закупочной цены' : <span className={r.saving >= 0 ? 'cp-good' : 'cp-bad'}>{r.saving >= 0 ? 'дешевле средней закупочной цены на' : 'дороже средней закупочной цены на'} {compact(Math.abs(r.saving))}</span>} />
                            <Line l="Ожидаемая прибыль" v={<>{compact(r.exp)} <small>(оценено {pc(r.assessedShare)} закупа; остальное ещё не продавалось)</small></>} />
                            <div className="cp-tbl-wrap"><table className="cp-tbl"><thead><tr><th>Металл</th><th>кг</th><th>Цена</th><th>Средняя закупа</th><th>Разница</th><th>Ср. продажа</th><th>Ожид. прибыль</th></tr></thead>
                              <tbody>{r.metals.map((m) => { const p = m.kg > 0 ? m.spent / m.kg : 0, d = m.avg_buy - p; return (
                                <tr key={m.product}><td>{m.product}</td><td>{nf0.format(m.kg)}</td><td>{nf1.format(p)}</td><td>{nf1.format(m.avg_buy)}</td><td className={d >= 0 ? 'cp-good' : 'cp-bad'}>{diffTxt(-d)}</td><td>{m.avg_sale == null ? '—' : nf1.format(m.avg_sale)}</td><td>{m.exp_profit == null ? 'не продавался' : compact(m.exp_profit)}</td></tr>); })}</tbody></table></div>
                            {r.single && onClient && <button type="button" className="pay-link" onClick={() => onClient(r.name)}>Открыть карточку клиента →</button>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )
          )}
        </>
      )}
    </section>
  );
}
