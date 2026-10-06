'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

// Графики «Закуп по дням» и «Средняя цена по дням» для отчёта Точки.
// Рисуются SVG по реальной ширине контейнера (без растягивания), с анимацией,
// подсказкой по наведению/касанию и общей подсветкой дня на обоих графиках.

export type ChartDay = { date: string; purchase_amount: number; purchase_kg: number };

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const rub = (v: number) => nf0.format(Math.round(v)) + ' ₸';
const kgf = (v: number) => nf1.format(v) + ' кг';
const compact = (v: number) => (v >= 1e6 ? `${nf1.format(v / 1e6)} млн` : v >= 1e3 ? `${nf0.format(v / 1e3)} тыс` : nf0.format(v));
const iso = (s: string) => String(s).slice(0, 10);
const asDate = (s: string) => { const [y, m, d] = iso(s).split('-').map(Number); return new Date(y, m - 1, d); };
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const dm = (s: string) => `${iso(s).slice(8, 10)}.${iso(s).slice(5, 7)}`;
const longDay = (s: string) => { const d = asDate(s); return `${WD[d.getDay()]}, ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`; };
const isWeekend = (s: string) => { const g = asDate(s).getDay(); return g === 0 || g === 6; };
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function niceStep(span: number, ticks: number) {
  const raw = Math.max(span, 1e-9) / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(Math.floor(el.getBoundingClientRect().width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// Монотонная кубическая кривая (без «заныриваний» между точками)
function monotone(P: Array<{ x: number; y: number }>) {
  const k = P.length;
  if (k < 2) return '';
  if (k === 2) return `M${P[0].x},${P[0].y} L${P[1].x},${P[1].y}`;
  const dx: number[] = [], m: number[] = [], t: number[] = new Array(k).fill(0);
  for (let i = 0; i < k - 1; i++) { dx[i] = P[i + 1].x - P[i].x; m[i] = (P[i + 1].y - P[i].y) / dx[i]; }
  t[0] = m[0]; t[k - 1] = m[k - 2];
  for (let i = 1; i < k - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const q = 3 / Math.sqrt(s); t[i] = q * a * m[i]; t[i + 1] = q * b * m[i]; }
  }
  let d = `M${P[0].x},${P[0].y}`;
  for (let i = 0; i < k - 1; i++) { const h = dx[i] / 3; d += ` C${P[i].x + h},${P[i].y + t[i] * h} ${P[i + 1].x - h},${P[i + 1].y - t[i + 1] * h} ${P[i + 1].x},${P[i + 1].y}`; }
  return d;
}

const H = 250;
const M = { l: 50, r: 12, t: 24, b: 28 };

function xLabels(count: number, bw: number) {
  const every = Math.max(1, Math.ceil(40 / Math.max(bw, 1)));
  const shown: number[] = [];
  for (let i = 0; i < count; i += every) shown.push(i);
  const last = count - 1;
  if (shown.length && shown[shown.length - 1] !== last && last - shown[shown.length - 1] >= every * 0.7) shown.push(last);
  return shown;
}

function Defs() {
  return (
    <defs>
      <linearGradient id="pc-green" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#86bb5c" /><stop offset="1" stopColor="#4d8a34" /></linearGradient>
      <linearGradient id="pc-orange" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f0b25a" /><stop offset="1" stopColor="#c9822f" /></linearGradient>
      <linearGradient id="pc-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#c9822f" stopOpacity="0.32" /><stop offset="1" stopColor="#c9822f" stopOpacity="0" /></linearGradient>
    </defs>
  );
}

function Tip({ x, w, day, d }: { x: number; w: number; day: string; d: ChartDay | undefined }) {
  const amount = n(d?.purchase_amount), kg = n(d?.purchase_kg);
  return (
    <div className="pc-tip" style={{ left: clamp(x, 92, Math.max(92, w - 92)), top: 4 }}>
      <div className="d">{longDay(day)}</div>
      {kg > 0 ? (
        <>
          <div><span>Закуп</span><b>{rub(amount)}</b></div>
          <div><span>Вес</span><b>{kgf(kg)}</b></div>
          <div><span>Цена</span><b>{nf1.format(amount / kg)} ₸/кг</b></div>
        </>
      ) : <div><span>Закупа не было</span></div>}
    </div>
  );
}

function PurchaseChart({ days, active, setActive }: { days: ChartDay[]; active: number | null; setActive: (i: number | null) => void }) {
  const [ref, w] = useWidth();
  const [metric, setMetric] = useState<'sum' | 'kg'>('sum');
  const cnt = days.length;
  const vals = useMemo(() => days.map((d) => (metric === 'sum' ? n(d.purchase_amount) : n(d.purchase_kg))), [days, metric]);
  const stats = useMemo(() => {
    const worked = vals.filter((v) => v > 0).length;
    const total = vals.reduce((a, v) => a + v, 0);
    let best = -1;
    vals.forEach((v, i) => { if (v > 0 && (best < 0 || v > vals[best])) best = i; });
    return { worked, total, avg: worked ? total / worked : 0, best };
  }, [vals]);
  const fmt = (v: number) => (metric === 'sum' ? rub(v) : kgf(v));

  const plotW = Math.max(10, w - M.l - M.r), plotH = H - M.t - M.b;
  const bw = cnt ? plotW / cnt : plotW;
  const barW = clamp(bw * 0.68, 2, 34);
  const maxV = Math.max(0, ...vals);
  const step = maxV > 0 ? niceStep(maxV, 4) : 1;
  const top = maxV > 0 ? Math.max(step, Math.ceil(maxV / step) * step) : 1;
  const y = (v: number) => M.t + plotH - (v / top) * plotH;
  const base = M.t + plotH;
  const grid: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) grid.push(v);
  const labels = xLabels(cnt, bw);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setActive(clamp(Math.floor((e.clientX - r.left - M.l) / bw), 0, cnt - 1));
  };

  return (
    <div className="pc-card">
      <div className="pc-top">
        <div className="pc-title">Закуп по дням</div>
        <div className="pc-seg">
          <button type="button" className={metric === 'sum' ? 'on' : ''} onClick={() => setMetric('sum')}>Сумма, ₸</button>
          <button type="button" className={metric === 'kg' ? 'on' : ''} onClick={() => setMetric('kg')}>Вес, кг</button>
        </div>
      </div>
      <div className="pc-chips">
        <div className="pc-chip"><small>Всего за период</small><b>{fmt(stats.total)}</b></div>
        <div className="pc-chip"><small>В среднем за рабочий день</small><b>{fmt(stats.avg)}</b></div>
        <div className="pc-chip"><small>Рекордный день</small><b>{stats.best >= 0 ? `${dm(days[stats.best].date)} · ${fmt(vals[stats.best])}` : '—'}</b></div>
        <div className="pc-chip"><small>Дней с закупом</small><b>{stats.worked} из {cnt}</b></div>
      </div>
      <div className="pc-wrap" ref={ref}>
        {cnt === 0 ? <div className="empty-state compact">Нет данных за период.</div> : w > 0 && (
          <>
            <svg className="pc-svg" width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label="Закуп по дням"
              onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setActive(null); }}>
              <Defs />
              {grid.map((g) => (
                <g key={g}>
                  <line x1={M.l} x2={w - M.r} y1={y(g)} y2={y(g)} stroke={g === 0 ? '#bfc4ae' : '#e6e8dc'} strokeWidth={1} />
                  <text x={M.l - 8} y={y(g) + 3.5} textAnchor="end" className="pc-ax">{metric === 'sum' ? compact(g) : nf0.format(g)}</text>
                </g>
              ))}
              {stats.avg > 0 && (
                <g>
                  <line x1={M.l} x2={w - M.r} y1={y(stats.avg)} y2={y(stats.avg)} stroke="#8d8a78" strokeWidth={1.2} strokeDasharray="5 4" />
                  <text x={w - M.r - 4} y={y(stats.avg) - 5} textAnchor="end" className="pc-avg">в среднем {metric === 'sum' ? compact(stats.avg) : nf0.format(stats.avg)}</text>
                </g>
              )}
              {active !== null && <rect x={M.l + bw * active} y={M.t} width={bw} height={plotH} fill="rgba(45,42,33,0.07)" rx={6} />}
              <g key={metric + cnt}>
                {vals.map((v, i) => {
                  const x = M.l + bw * i + (bw - barW) / 2;
                  if (v <= 0) return <rect key={i} x={x} y={base - 2} width={barW} height={2} rx={1} fill={isWeekend(days[i].date) ? '#d9dccb' : '#c8ccb8'} />;
                  const yt = y(v), rr = Math.min(6, barW / 2, base - yt);
                  const d = `M${x},${base} V${yt + rr} Q${x},${yt} ${x + rr},${yt} H${x + barW - rr} Q${x + barW},${yt} ${x + barW},${yt + rr} V${base} Z`;
                  return <path key={i} d={d} fill={i === stats.best ? 'url(#pc-orange)' : 'url(#pc-green)'} className={`pc-bar${active === i ? ' act' : ''}`} style={{ animationDelay: `${Math.min(i * 14, 500)}ms` }} />;
                })}
              </g>
              {stats.best >= 0 && (() => {
                const x = M.l + bw * stats.best + bw / 2, yt = y(vals[stats.best]);
                const txt = metric === 'sum' ? compact(vals[stats.best]) : nf0.format(vals[stats.best]);
                return <text x={clamp(x, M.l + 18, w - M.r - 18)} y={yt - 7} textAnchor="middle" className="pc-peak">{txt}</text>;
              })()}
              {labels.map((i) => (
                <text key={i} x={M.l + bw * i + bw / 2} y={H - 8} textAnchor="middle" className={`pc-ax${isWeekend(days[i].date) ? ' we' : ''}`}>{dm(days[i].date)}</text>
              ))}
            </svg>
            {active !== null && <Tip x={M.l + bw * active + bw / 2} w={w} day={days[active].date} d={days[active]} />}
          </>
        )}
      </div>
    </div>
  );
}

function PriceChart({ days, active, setActive }: { days: ChartDay[]; active: number | null; setActive: (i: number | null) => void }) {
  const [ref, w] = useWidth();
  const cnt = days.length;
  const pts = useMemo(() => days.map((d, i) => ({ i, date: d.date, kg: n(d.purchase_kg), amount: n(d.purchase_amount), price: n(d.purchase_kg) > 0 ? n(d.purchase_amount) / n(d.purchase_kg) : null })), [days]);
  const priced = useMemo(() => pts.filter((p) => p.price !== null) as Array<{ i: number; date: string; kg: number; amount: number; price: number }>, [pts]);
  const st = useMemo(() => {
    if (!priced.length) return null;
    const totalKg = priced.reduce((a, p) => a + p.kg, 0), totalAmt = priced.reduce((a, p) => a + p.amount, 0);
    let lo = priced[0], hi = priced[0];
    priced.forEach((p) => { if (p.price < lo.price) lo = p; if (p.price > hi.price) hi = p; });
    const first = priced[0], last = priced[priced.length - 1];
    return { avg: totalKg ? totalAmt / totalKg : 0, lo, hi, first, last, change: priced.length > 1 ? (last.price / first.price - 1) * 100 : null };
  }, [priced]);

  const plotW = Math.max(10, w - M.l - M.r), plotH = H - M.t - M.b;
  const bw = cnt ? plotW / cnt : plotW;
  const lo = st?.lo.price ?? 0, hi = st?.hi.price ?? 1;
  const span = Math.max(hi - lo, hi * 0.04, 1);
  const stepP = niceStep(span * 1.3, 4);
  const a = Math.floor((lo - span * 0.12) / stepP) * stepP, b = Math.ceil((hi + span * 0.12) / stepP) * stepP;
  const yMin = Math.max(0, a), yMax = b > yMin ? b : yMin + stepP;
  const y = (v: number) => M.t + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const x = (i: number) => M.l + bw * i + bw / 2;
  const base = M.t + plotH;
  const grid: number[] = [];
  for (let v = yMin; v <= yMax + 1e-9; v += stepP) grid.push(v);
  const labels = xLabels(cnt, bw);

  // серии подряд идущих дней с закупом + пунктирные «мосты» через пропуски
  const runs = useMemo(() => {
    const out: Array<Array<{ x: number; y: number }>> = [];
    let cur: Array<{ x: number; y: number }> = [], prev = -2;
    priced.forEach((p) => {
      if (p.i !== prev + 1 && cur.length) { out.push(cur); cur = []; }
      cur.push({ x: x(p.i), y: y(p.price) });
      prev = p.i;
    });
    if (cur.length) out.push(cur);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priced, w, yMin, yMax]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setActive(clamp(Math.floor((e.clientX - r.left - M.l) / bw), 0, cnt - 1));
  };
  const trendUp = (st?.change ?? 0) > 0;

  return (
    <div className="pc-card">
      <div className="pc-top"><div className="pc-title">Средняя цена закупа, ₸/кг</div></div>
      <div className="pc-chips">
        <div className="pc-chip"><small>Средняя за период</small><b>{st ? `${nf1.format(st.avg)} ₸` : '—'}</b></div>
        <div className="pc-chip"><small>Минимум</small><b>{st ? `${nf1.format(st.lo.price)} ₸ · ${dm(st.lo.date)}` : '—'}</b></div>
        <div className="pc-chip"><small>Максимум</small><b>{st ? `${nf1.format(st.hi.price)} ₸ · ${dm(st.hi.date)}` : '—'}</b></div>
        <div className={`pc-chip ${st?.change == null ? '' : trendUp ? 'up' : 'down'}`}><small>Изменение с {st ? dm(st.first.date) : '—'}</small><b>{st?.change == null ? '—' : `${trendUp ? '▲' : '▼'} ${nf1.format(Math.abs(st.change))}%`}</b></div>
      </div>
      <div className="pc-wrap" ref={ref}>
        {cnt === 0 || !st ? <div className="empty-state compact">За период не было закупа — считать среднюю цену не по чему.</div> : w > 0 && (
          <>
            <svg className="pc-svg" width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label="Средняя цена закупа по дням"
              onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setActive(null); }}>
              <Defs />
              {grid.map((g) => (
                <g key={g}>
                  <line x1={M.l} x2={w - M.r} y1={y(g)} y2={y(g)} stroke="#e6e8dc" strokeWidth={1} />
                  <text x={M.l - 8} y={y(g) + 3.5} textAnchor="end" className="pc-ax">{nf0.format(g)}</text>
                </g>
              ))}
              <line x1={M.l} x2={w - M.r} y1={y(st.avg)} y2={y(st.avg)} stroke="#8d8a78" strokeWidth={1.2} strokeDasharray="5 4" />
              <text x={w - M.r - 4} y={y(st.avg) - 5} textAnchor="end" className="pc-avg">средняя {nf1.format(st.avg)}</text>
              {active !== null && <line x1={x(active)} x2={x(active)} y1={M.t} y2={base} stroke="#2d2b23" strokeOpacity={0.35} strokeDasharray="3 3" />}
              <g key={priced.length + (priced[0]?.date ?? '')}>
                {runs.map((r, k) => (r.length > 1 ? <path key={`a${k}`} d={`${monotone(r)} L${r[r.length - 1].x},${base} L${r[0].x},${base} Z`} fill="url(#pc-area)" className="pc-area" /> : null))}
                {runs.slice(1).map((r, k) => { const p = runs[k][runs[k].length - 1]; return <line key={`g${k}`} x1={p.x} y1={p.y} x2={r[0].x} y2={r[0].y} stroke="#c9822f" strokeOpacity={0.55} strokeWidth={2} strokeDasharray="4 5" strokeLinecap="round" />; })}
                {runs.map((r, k) => (r.length > 1 ? <path key={`l${k}`} d={monotone(r)} pathLength={1} className="pc-line" /> : null))}
                {priced.map((p, k) => {
                  const on = active === p.i, isLo = p === st.lo, isHi = p === st.hi;
                  return <circle key={p.i} cx={x(p.i)} cy={y(p.price)} r={on ? 7 : isLo || isHi ? 5.5 : 4} fill="#fff" stroke={isHi ? '#b4631d' : isLo ? '#3e7b5d' : '#c9822f'} strokeWidth={on ? 3 : 2.5} className="pc-dot" style={{ animationDelay: `${Math.min(k * 40, 700)}ms` }} />;
                })}
              </g>
              {st.hi !== st.lo && (
                <>
                  <text x={clamp(x(st.hi.i), M.l + 20, w - M.r - 20)} y={y(st.hi.price) - 11} textAnchor="middle" className="pc-peak hi">{nf0.format(st.hi.price)}</text>
                  <text x={clamp(x(st.lo.i), M.l + 20, w - M.r - 20)} y={y(st.lo.price) + 21} textAnchor="middle" className="pc-peak lo">{nf0.format(st.lo.price)}</text>
                </>
              )}
              {labels.map((i) => (
                <text key={i} x={x(i)} y={H - 8} textAnchor="middle" className={`pc-ax${isWeekend(days[i].date) ? ' we' : ''}`}>{dm(days[i].date)}</text>
              ))}
            </svg>
            {active !== null && <Tip x={x(active)} w={w} day={days[active].date} d={days[active]} />}
          </>
        )}
      </div>
    </div>
  );
}

export function DailyCharts({ days }: { days: ChartDay[] }) {
  const [active, setActive] = useState<number | null>(null);
  const sorted = useMemo(() => [...days].sort((p, q) => iso(p.date).localeCompare(iso(q.date))), [days]);
  return (
    <div className="pc-grid" onPointerLeave={(e) => { if (e.pointerType === 'mouse') setActive(null); }}>
      <PurchaseChart days={sorted} active={active} setActive={setActive} />
      <PriceChart days={sorted} active={active} setActive={setActive} />
    </div>
  );
}
