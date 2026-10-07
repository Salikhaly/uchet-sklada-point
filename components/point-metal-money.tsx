'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { CountUp } from './point-report-shell';
import type { PurchaseRow } from './point-metals';

// Экран «Остатки»: деньги в металле глазами владельца.
//  • сколько денег лежит в остатках и в каких металлах (и от какой цены нельзя продавать);
//  • не подешевел ли закуп относительно себестоимости остатка;
//  • прибыль по металлам (когда были отгрузки/продажи) и структура закупа (на чём держится оборот).

export type MetalRow = {
  product: string; category: string | null; sort_order: number | null;
  buy_kg: number; buy_amount: number;
  ship_kg: number; ship_amount: number; ship_cogs: number;
  sale_kg: number; sale_amount: number; sale_cogs: number;
  transfer_kg: number; transfer_cogs: number;
  stock_kg: number; stock_cost: number; avg_cost: number;
};

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const rub = (v: number) => nf0.format(Math.round(v)) + ' ₸';
const compact = (v: number) => { const a = Math.abs(v); const s = a >= 1e6 ? `${nf1.format(a / 1e6)} млн` : a >= 1e3 ? `${nf0.format(a / 1e3)} тыс` : nf0.format(a); return (v < 0 ? '−' : '') + s + ' ₸'; };
const price = (v: number) => (v >= 1000 ? nf0 : nf1).format(v) + ' ₸/кг';
const kgf = (v: number) => nf1.format(v) + ' кг';
const pc = (v: number) => nf1.format(v) + '%';
const iso = (s: string) => String(s).slice(0, 10);
const dm = (s: string) => `${iso(s).slice(8, 10)}.${iso(s).slice(5, 7)}`;
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };

type M = MetalRow & { out_kg: number; revenue: number; cogs: number; profit: number; perKg: number | null; markup: number | null; last?: { price: number; date: string } };

function enrich(rows: MetalRow[], purchases: PurchaseRow[]): M[] {
  const last = new Map<string, { price: number; date: string }>();
  [...purchases].sort((a, b) => iso(a.date).localeCompare(iso(b.date))).forEach((r) => {
    const kg = n(r.kg);
    if (kg > 0) last.set(r.product, { price: n(r.amount) / kg, date: iso(r.date) });
  });
  return rows.map((r) => {
    const out_kg = n(r.ship_kg) + n(r.sale_kg), revenue = n(r.ship_amount) + n(r.sale_amount), cogs = n(r.ship_cogs) + n(r.sale_cogs);
    const profit = revenue - cogs;
    return { ...r, out_kg, revenue, cogs, profit, perKg: out_kg > 0 ? profit / out_kg : null, markup: cogs > 0 ? (profit / cogs) * 100 : null, last: last.get(r.product) };
  });
}
const sum = (list: M[], k: keyof M) => list.reduce((a, x) => a + n(x[k]), 0);

type BarRow = { key: string; label: string; sub?: string; value: number; shown: string; width: number; color: string; tag?: { text: string; tone: 'warn' | 'ok' | 'mute' }; detail?: ReactNode };

function BarList({ rows }: { rows: BarRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="mm-list" data-noswipe>
      {rows.map((r, i) => (
        <div key={r.key} className={`mm-item${open === r.key ? ' open' : ''}`}>
          <button type="button" className="mm-row" onClick={() => setOpen(open === r.key ? null : r.key)}>
            <span className="mm-name"><i style={{ background: `hsl(${hue(r.label)} 50% 55%)` }} /><b>{r.label}</b>{r.sub && <small>{r.sub}</small>}</span>
            <span className="mm-bar"><span style={{ width: `${Math.max(2, Math.min(100, r.width))}%`, background: r.color, animationDelay: `${Math.min(i * 40, 500)}ms` }} /></span>
            <span className="mm-val"><b>{r.shown}</b>{r.tag && <em className={r.tag.tone}>{r.tag.text}</em>}</span>
          </button>
          {open === r.key && r.detail && <div className="mm-detail">{r.detail}</div>}
        </div>
      ))}
    </div>
  );
}

const Line = ({ l, v }: { l: string; v: ReactNode }) => <div className="mm-line"><span>{l}</span><b>{v}</b></div>;

export function MetalMoney({ cur, prev, purchases, from, to }: { cur: MetalRow[]; prev: MetalRow[] | null; purchases: PurchaseRow[]; from: string; to: string }) {
  const [tab, setTab] = useState<'profit' | 'mix' | null>(null);
  const [pm, setPm] = useState<'sum' | 'perkg' | 'markup'>('sum');
  const [mm, setMm] = useState<'sum' | 'kg'>('sum');

  const rows = useMemo(() => enrich(cur, purchases), [cur, purchases]);
  const prevRows = useMemo(() => (prev ? enrich(prev, []) : null), [prev]);

  const periodDays = Math.max(1, Math.round((new Date(iso(to) + 'T00:00:00').getTime() - new Date(iso(from) + 'T00:00:00').getTime()) / 86400000) + 1);
  const stockRows = useMemo(() => rows.filter((r) => n(r.stock_cost) > 0 || n(r.stock_kg) > 0).sort((a, b) => n(b.stock_cost) - n(a.stock_cost)), [rows]);
  const stockTotal = sum(rows, 'stock_cost'), stockKg = sum(rows, 'stock_kg');
  const buyTotal = sum(rows, 'buy_amount'), buyKg = sum(rows, 'buy_kg');
  const outKg = sum(rows, 'out_kg'), cogs = sum(rows, 'cogs'), revenue = sum(rows, 'revenue');
  const profit = revenue - cogs;
  const prevBuy = prevRows ? sum(prevRows, 'buy_amount') : null;
  const prevProfit = prevRows ? sum(prevRows, 'revenue') - sum(prevRows, 'cogs') : null;
  const hasOut = outKg > 0;
  const tabNow = tab ?? (hasOut ? 'profit' : 'mix');

  const delta = (now: number, was: number | null) => (was == null || was === 0 ? null : ((now - was) / Math.abs(was)) * 100);
  const dBuy = delta(buyTotal, prevBuy), dProfit = delta(profit, prevProfit);
  const Delta = ({ d }: { d: number | null }) => (d == null ? <small className="mm-dl">нет данных за прошлый период</small> : <small className={`mm-dl ${d >= 0 ? 'up' : 'down'}`}>{d >= 0 ? '▲' : '▼'} {pc(Math.abs(d))} к прошлому периоду</small>);

  // ── выводы простыми словами ──
  const insights: Array<{ icon: string; tone: 'warn' | 'ok' | 'info'; text: ReactNode }> = [];
  if (stockRows.length) {
    const top = stockRows[0];
    insights.push({ icon: '📦', tone: 'info', text: <>Больше всего денег лежит в «<b>{top.product}</b>»: {compact(top.stock_cost)} — это {pc((n(top.stock_cost) / Math.max(1, stockTotal)) * 100)} всего остатка.</> });
  }
  const idle = stockRows.filter((r) => r.out_kg === 0 && n(r.stock_cost) > 0);
  if (idle.length && stockRows.length) {
    const idleCost = idle.reduce((a, r) => a + n(r.stock_cost), 0);
    insights.push({ icon: '⏳', tone: 'warn', text: hasOut
      ? <>За период не уходили {idle.length} из {stockRows.length} металлов — в них {compact(idleCost)} ({pc((idleCost / Math.max(1, stockTotal)) * 100)} остатка).</>
      : <>За период ничего не отгружали и не продавали: всё закупленное лежит в остатках, {compact(stockTotal)}.</> });
  }
  const drops = stockRows.filter((r) => r.last && n(r.avg_cost) > 0 && r.last.price < n(r.avg_cost) * 0.95 && n(r.stock_cost) > 100000)
    .map((r) => ({ r, d: (r.last!.price / n(r.avg_cost) - 1) * 100, loss: (r.last!.price - n(r.avg_cost)) * n(r.stock_kg) })).sort((a, b) => a.loss - b.loss);
  if (drops.length) insights.push({ icon: '⚠️', tone: 'warn', text: <>Закуп дешевле себестоимости остатка: {drops.slice(0, 3).map((x, i) => <span key={x.r.product}>{i ? '; ' : ''}<b>{x.r.product}</b> {pc(x.d)} ({price(x.r.last!.price)} против {price(n(x.r.avg_cost))})</span>)}. Если цена рынка тоже упала, остаток подешевел примерно на {compact(Math.abs(drops.reduce((a, x) => a + x.loss, 0)))}.</> });
  const rises = stockRows.filter((r) => r.last && n(r.avg_cost) > 0 && r.last.price > n(r.avg_cost) * 1.05 && n(r.stock_cost) > 100000);
  if (rises.length) insights.push({ icon: '✅', tone: 'ok', text: <>Остаток дешевле нового закупа: {rises.slice(0, 3).map((r, i) => <span key={r.product}>{i ? '; ' : ''}<b>{r.product}</b> +{pc((r.last!.price / n(r.avg_cost) - 1) * 100)}</span>)} — по этим металлам цена идёт вверх.</> });
  if (hasOut) {
    const sold = rows.filter((r) => r.out_kg > 0).sort((a, b) => b.profit - a.profit);
    const best = sold[0], worst = sold[sold.length - 1];
    insights.push({ icon: '💎', tone: profit >= 0 ? 'ok' : 'warn', text: <>Прибыль за период {compact(profit)}{cogs > 0 ? `, наценка ${pc((profit / cogs) * 100)}` : ''}. Лучший металл — <b>{best.product}</b> ({compact(best.profit)}){worst && worst !== best && worst.profit < 0 ? <>; в минусе — <b>{worst.product}</b> ({compact(worst.profit)})</> : null}.</> });
  } else insights.push({ icon: '💎', tone: 'info', text: <>Прибыль появится после первой отгрузки или продажи — тогда здесь будет видно, на каком металле вы зарабатываете.</> });

  // ── левая панель: где лежат деньги ──
  const maxStock = Math.max(1, ...stockRows.map((r) => n(r.stock_cost)));
  const stockBars: BarRow[] = stockRows.map((r) => {
    const days = r.out_kg > 0 ? n(r.stock_kg) / (r.out_kg / periodDays) : null;
    const dropPct = r.last && n(r.avg_cost) > 0 ? (r.last.price / n(r.avg_cost) - 1) * 100 : null;
    return {
      key: r.product, label: r.product, sub: `${kgf(n(r.stock_kg))} × ${price(n(r.avg_cost))}`, value: n(r.stock_cost), shown: compact(n(r.stock_cost)),
      width: (n(r.stock_cost) / maxStock) * 100, color: r.out_kg === 0 ? '#b9a98a' : '#6f86b8',
      tag: r.out_kg === 0 ? { text: 'не уходил', tone: 'warn' } : days != null ? { text: days > 365 ? '> года запаса' : `≈ ${nf0.format(days)} дн. запаса`, tone: days > 90 ? 'warn' : 'mute' } : undefined,
      detail: (
        <>
          <Line l="Остаток" v={`${kgf(n(r.stock_kg))} · ${rub(n(r.stock_cost))} (${pc((n(r.stock_cost) / Math.max(1, stockTotal)) * 100)} всех денег в остатках)`} />
          <Line l="Не продавать ниже" v={<>{price(n(r.avg_cost))} <small>(себестоимость остатка)</small></>} />
          {r.last && <Line l="Последний закуп" v={<>{price(r.last.price)} · {dm(r.last.date)}{dropPct != null && Math.abs(dropPct) >= 0.5 && <em className={dropPct < 0 ? 'down-bad' : 'up-good'}> {dropPct < 0 ? '▼' : '▲'} {pc(Math.abs(dropPct))} к себестоимости остатка</em>}</>} />}
          <Line l="Закуплено за период" v={n(r.buy_kg) > 0 ? `${kgf(n(r.buy_kg))} на ${rub(n(r.buy_amount))} · в среднем ${price(n(r.buy_amount) / n(r.buy_kg))}` : '—'} />
          <Line l="Отгружено и продано" v={r.out_kg > 0 ? `${kgf(r.out_kg)} на ${rub(r.revenue)}${r.perKg != null ? ` · прибыль ${compact(r.profit)}` : ''}` : 'не уходил за период'} />
          {n(r.transfer_kg) > 0 && <Line l="Передано в Ангар" v={`${kgf(n(r.transfer_kg))} (по себестоимости ${rub(n(r.transfer_cogs))})`} />}
        </>
      ),
    };
  });

  // ── правая панель: прибыль / структура закупа ──
  const soldRows = rows.filter((r) => r.out_kg > 0);
  const pVal = (r: M) => (pm === 'sum' ? r.profit : pm === 'perkg' ? r.perKg ?? 0 : r.markup ?? 0);
  const profitSorted = [...soldRows].sort((a, b) => pVal(b) - pVal(a));
  const pMax = Math.max(1, ...profitSorted.map((r) => Math.abs(pVal(r))));
  const profitBars: BarRow[] = profitSorted.map((r) => ({
    key: r.product, label: r.product, sub: `${kgf(r.out_kg)} · выручка ${compact(r.revenue)}`, value: pVal(r),
    shown: pm === 'sum' ? compact(r.profit) : pm === 'perkg' ? `${nf1.format(r.perKg ?? 0)} ₸/кг` : r.markup == null ? '—' : pc(r.markup),
    width: (Math.abs(pVal(r)) / pMax) * 100, color: pVal(r) >= 0 ? '#3e7b5d' : '#a44731',
    tag: r.profit < 0 ? { text: 'в минусе', tone: 'warn' } : undefined,
    detail: (
      <>
        <Line l="Выручка / себестоимость" v={`${rub(r.revenue)} / ${rub(r.cogs)}`} />
        <Line l="Прибыль" v={`${rub(r.profit)}${r.markup != null ? ` · наценка ${pc(r.markup)}` : ''}`} />
        <Line l="Цена отгрузки / себестоимость" v={`${price(r.revenue / r.out_kg)} / ${price(r.cogs / r.out_kg)} → спред ${nf1.format(r.profit / r.out_kg)} ₸/кг`} />
      </>
    ),
  }));
  const mixSorted = useMemo(() => rows.filter((r) => n(r.buy_kg) > 0).sort((a, b) => (mm === 'sum' ? n(b.buy_amount) - n(a.buy_amount) : n(b.buy_kg) - n(a.buy_kg))), [rows, mm]);
  const mixTotal = mixSorted.reduce((a, r) => a + (mm === 'sum' ? n(r.buy_amount) : n(r.buy_kg)), 0);
  const mixMax = Math.max(1, ...mixSorted.map((r) => (mm === 'sum' ? n(r.buy_amount) : n(r.buy_kg))));
  let cum = 0;
  const mixBars: BarRow[] = mixSorted.map((r) => {
    const v = mm === 'sum' ? n(r.buy_amount) : n(r.buy_kg);
    const before = cum; cum += v;
    return {
      key: r.product, label: r.product, sub: `${kgf(n(r.buy_kg))} · ${price(n(r.buy_amount) / n(r.buy_kg))}`, value: v,
      shown: `${mm === 'sum' ? compact(v) : kgf(v)} · ${pc((v / Math.max(1, mixTotal)) * 100)}`, width: (v / mixMax) * 100, color: before / Math.max(1, mixTotal) < 0.8 ? '#c9822f' : '#cdbf9f',
      tag: before / Math.max(1, mixTotal) < 0.8 ? { text: 'основа 80%', tone: 'mute' } : undefined,
    };
  });

  if (!rows.length) return <div className="empty-state compact">Данных по металлу за период нет.</div>;

  return (
    <div className="mm">
      <div className="mm-strip">
        <div className="mm-stat"><small>Деньги в остатках сейчас</small><b><CountUp value={stockTotal} format={rub} /></b><small>{kgf(stockKg)} в {stockRows.length} металлах</small></div>
        <div className="mm-stat"><small>Закуплено за период</small><b><CountUp value={buyTotal} format={rub} /></b><Delta d={dBuy} /></div>
        <div className="mm-stat"><small>Прибыль за период</small><b className={profit < 0 ? 'neg' : ''}>{hasOut ? <CountUp value={profit} format={rub} /> : '—'}</b>{hasOut ? <Delta d={dProfit} /> : <small className="mm-dl">отгрузок и продаж не было</small>}</div>
        <div className="mm-stat"><small>Ушло из закупленного</small><b><CountUp value={buyKg > 0 ? (outKg / buyKg) * 100 : 0} format={(v) => pc(v)} /></b><small>{kgf(outKg)} из {kgf(buyKg)}</small></div>
      </div>

      <div className="mm-insights">
        {insights.map((x, i) => <div key={i} className={`mm-ins ${x.tone}`} style={{ animationDelay: `${i * 70}ms` }}><span>{x.icon}</span><p>{x.text}</p></div>)}
      </div>

      <div className="mm-cols">
        <div className="mm-panel">
          <div className="mm-ph"><b>Где лежат деньги</b><span>по себестоимости остатка · нажмите на металл</span></div>
          {stockBars.length ? <BarList rows={stockBars} /> : <div className="empty-state compact">Остатков нет.</div>}
        </div>
        <div className="mm-panel">
          <div className="mm-ph">
            <div className="pc-seg">
              <button type="button" className={tabNow === 'profit' ? 'on' : ''} onClick={() => setTab('profit')}>Прибыль</button>
              <button type="button" className={tabNow === 'mix' ? 'on' : ''} onClick={() => setTab('mix')}>Структура закупа</button>
            </div>
            {tabNow === 'profit'
              ? <div className="pc-seg"><button type="button" className={pm === 'sum' ? 'on' : ''} onClick={() => setPm('sum')}>₸</button><button type="button" className={pm === 'perkg' ? 'on' : ''} onClick={() => setPm('perkg')}>₸ за кг</button><button type="button" className={pm === 'markup' ? 'on' : ''} onClick={() => setPm('markup')}>Наценка</button></div>
              : <div className="pc-seg"><button type="button" className={mm === 'sum' ? 'on' : ''} onClick={() => setMm('sum')}>₸</button><button type="button" className={mm === 'kg' ? 'on' : ''} onClick={() => setMm('kg')}>кг</button></div>}
          </div>
          {tabNow === 'profit'
            ? (profitBars.length ? <BarList rows={profitBars} /> : <div className="empty-state compact">За период не было отгрузок и продаж, поэтому прибыль считать не по чему. Загляните в «Структуру закупа».</div>)
            : <BarList rows={mixBars} />}
        </div>
      </div>
    </div>
  );
}
