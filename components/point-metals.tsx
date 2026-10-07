'use client';

import { useMemo, useState } from 'react';
import { MetalCharts, type ChartDay } from './point-charts';

// Экран «Цены»: закуп и цена по каждому металлу отдельно (общая «средняя цена» смешивает медь и лом
// и ничего не говорит). Слева рейтинг металлов, справа — выбранный металл: график цены и закупа по дням.

export type PurchaseRow = { date: string; product: string; category: string | null; sort_order?: number | null; kg: number; amount: number };

type Point = { date: string; kg: number; amount: number; price: number };
type Stat = { name: string; category: string | null; kg: number; amount: number; avg: number; min: Point; max: Point; first: Point; last: Point; change: number | null; days: number; series: Point[] };

const ALL = '__all__';
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const rub = (v: number) => nf0.format(Math.round(v)) + ' ₸';
const price = (v: number) => (v >= 1000 ? nf0 : nf1).format(v) + ' ₸';
const kgf = (v: number) => nf1.format(v) + ' кг';
const iso = (s: string) => String(s).slice(0, 10);
const dm = (s: string) => `${iso(s).slice(8, 10)}.${iso(s).slice(5, 7)}`;
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };

function daysBetween(from: string, to: string) {
  const out: string[] = [];
  const [y1, m1, d1] = iso(from).split('-').map(Number), [y2, m2, d2] = iso(to).split('-').map(Number);
  const a = new Date(y1, m1 - 1, d1), b = new Date(y2, m2 - 1, d2);
  for (let d = a, g = 0; d <= b && g < 400; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), g++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

function mk(name: string, category: string | null, byDate: Map<string, { kg: number; amount: number }>): Stat | null {
  const series: Point[] = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, kg: v.kg, amount: v.amount, price: v.kg > 0 ? v.amount / v.kg : 0 })).filter((x) => x.kg > 0);
  if (!series.length) return null;
  const kg = series.reduce((a, x) => a + x.kg, 0), amount = series.reduce((a, x) => a + x.amount, 0);
  let min = series[0], max = series[0];
  series.forEach((p) => { if (p.price < min.price) min = p; if (p.price > max.price) max = p; });
  const first = series[0], last = series[series.length - 1];
  return { name, category, kg, amount, avg: kg > 0 ? amount / kg : 0, min, max, first, last, change: series.length > 1 && first.price > 0 ? (last.price / first.price - 1) * 100 : null, days: series.length, series };
}

function Spark({ s, from, to }: { s: Stat; from: string; to: string }) {
  const W = 84, H = 26;
  const days = daysBetween(from, to);
  const idx = new Map(days.map((d, i) => [d, i]));
  const span = Math.max(1, days.length - 1);
  const lo = s.min.price, hi = s.max.price;
  const pts = s.series.map((p) => ({ x: 3 + ((idx.get(iso(p.date)) ?? 0) / span) * (W - 6), y: hi === lo ? H / 2 : H - 4 - ((p.price - lo) / (hi - lo)) * (H - 8) }));
  const color = s.change == null ? '#8d8a78' : s.change > 0 ? '#b4631d' : '#3e7b5d';
  const last = pts[pts.length - 1];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="mp-spark" aria-hidden>
      {pts.length > 1 && <polyline points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
      <circle cx={last.x} cy={last.y} r={3} fill={color} />
    </svg>
  );
}

type SortKey = 'amount' | 'kg' | 'price' | 'change';

export function MetalPrices({ rows, from, to }: { rows: PurchaseRow[]; from: string; to: string }) {
  const [sel, setSel] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('amount');

  const stats = useMemo(() => {
    const m = new Map<string, { category: string | null; by: Map<string, { kg: number; amount: number }> }>();
    rows.forEach((r) => {
      const e = m.get(r.product) || { category: r.category, by: new Map() };
      const d = iso(r.date), cur = e.by.get(d) || { kg: 0, amount: 0 };
      e.by.set(d, { kg: cur.kg + n(r.kg), amount: cur.amount + n(r.amount) });
      m.set(r.product, e);
    });
    return [...m.entries()].map(([name, e]) => mk(name, e.category, e.by)).filter((x): x is Stat => !!x);
  }, [rows]);

  const all = useMemo(() => {
    const by = new Map<string, { kg: number; amount: number }>();
    rows.forEach((r) => { const d = iso(r.date), c = by.get(d) || { kg: 0, amount: 0 }; by.set(d, { kg: c.kg + n(r.kg), amount: c.amount + n(r.amount) }); });
    return mk('Все металлы', null, by);
  }, [rows]);

  const ordered = useMemo(() => {
    const v = (s: Stat) => (sort === 'amount' ? s.amount : sort === 'kg' ? s.kg : sort === 'price' ? s.avg : s.change ?? -Infinity);
    return [...stats].sort((a, b) => v(b) - v(a));
  }, [stats, sort]);

  const byAmount = useMemo(() => [...stats].sort((a, b) => b.amount - a.amount), [stats]);
  const cur: Stat | null = sel === ALL ? all : stats.find((s) => s.name === sel) ?? byAmount[0] ?? null;

  const chartDays: ChartDay[] = useMemo(() => {
    if (!cur) return [];
    const m = new Map(cur.series.map((p) => [iso(p.date), p]));
    return daysBetween(from, to).map((d) => ({ date: d, purchase_amount: m.get(d)?.amount ?? 0, purchase_kg: m.get(d)?.kg ?? 0 }));
  }, [cur, from, to]);

  if (!cur || !stats.length) return <div className="empty-state compact">За период закупа нет — считать цены не по чему.</div>;

  const sortBtn = (k: SortKey, label: string) => <button key={k} type="button" className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{label}{sort === k ? ' ↓' : ''}</button>;
  const rowFor = (s: Stat, key: string, label: string, sub: string) => {
    const on = cur.name === s.name;
    return (
      <button key={key} type="button" className={`mp-row${on ? ' on' : ''}`} onClick={() => setSel(key)}>
        <span className="mp-name"><i style={{ background: key === ALL ? '#8d8a78' : `hsl(${hue(s.name)} 50% 55%)` }} /><b>{label}</b><small>{sub}</small></span>
        <span>{kgf(s.kg)}</span>
        <span><b>{price(s.avg)}</b></span>
        <span className={s.change == null ? '' : s.change > 0 ? 'up' : 'down'}>{s.change == null ? '—' : `${s.change > 0 ? '▲' : '▼'} ${nf1.format(Math.abs(s.change))}%`}</span>
        <Spark s={s} from={from} to={to} />
      </button>
    );
  };

  return (
    <div className="mp">
      <div className="mp-left">
        <div className="mp-head">
          <span>Металл</span>
          {sortBtn('kg', 'Закуплено')}
          {sortBtn('price', 'Ср. цена')}
          {sortBtn('change', 'Изменение')}
          <span />
        </div>
        <div className="mp-list" data-noswipe>
          {all && rowFor(all, ALL, 'Все металлы', 'общая — смешивает разные металлы')}
          {ordered.map((s) => rowFor(s, s.name, s.name, `${s.category || 'без категории'} · ${s.days} ${s.days === 1 ? 'день' : 'дн.'}`))}
        </div>
        <p className="pv-hint">Сортировка — по заголовкам колонок. Нажмите на металл, чтобы увидеть его цену и закуп по дням справа.</p>
      </div>

      <div className="mp-detail">
        <div className="mp-title">
          <div><b>{cur.name}</b>{cur.category && <em>{cur.category}</em>}</div>
          <span>Последняя цена: <b>{price(cur.last.price)}</b> · {dm(cur.last.date)}{cur.change != null && <> · с {dm(cur.first.date)} <b className={cur.change > 0 ? 'up' : 'down'}>{cur.change > 0 ? '▲' : '▼'} {nf1.format(Math.abs(cur.change))}%</b></>}</span>
          <span>Закуплено: <b>{kgf(cur.kg)}</b> на <b>{rub(cur.amount)}</b> за {cur.days} {cur.days === 1 ? 'день' : 'дн.'}</span>
        </div>
        {sel === ALL && <p className="mp-note">Общая цена зависит от того, какие металлы покупали в конкретный день. Для сравнения смотрите отдельные металлы.</p>}
        <MetalCharts key={cur.name} days={chartDays} name={cur.name} />
      </div>
    </div>
  );
}
