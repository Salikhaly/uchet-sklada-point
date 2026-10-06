'use client';

import { useMemo, useRef, useState } from 'react';

// Живые блоки отчёта Точки: «Люди» (столбики с долями) и «Статьи» (кольцо + записи + динамика по дням).

export type VizItem = { date: string; category: string; amount: number; comment?: string | null; is_loan: boolean };
export type VizPerson = { employee_id: string | null; name: string; hidden: boolean; advance: number; salary: number; other: number; loan_given: number; total: number; items: VizItem[] };
export type VizCategory = { category: string; amount: number; count: number };

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const rub = (v: number) => nf0.format(Math.round(v)) + ' ₸';
const compact = (v: number) => (v >= 1e6 ? `${nf1.format(v / 1e6)} млн` : v >= 1e3 ? `${nf0.format(v / 1e3)} тыс` : nf0.format(v));
const iso = (s: string) => String(s).slice(0, 10);
const dm = (s: string) => `${iso(s).slice(8, 10)}.${iso(s).slice(5, 7)}`;
const letter = (name: string) => (name.trim().charAt(0) || '?').toUpperCase();
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const avatarBg = (name: string) => `hsl(${hue(name)} 45% 86%)`;

/* ───────────────────────────── ЛЮДИ ───────────────────────────── */

type Kind = 'adv' | 'sal' | 'exp' | 'loan';
const KINDS: Array<{ k: Kind; label: string; color: string }> = [
  { k: 'adv', label: 'Аванс', color: '#c9822f' },
  { k: 'sal', label: 'Зарплата', color: '#3e7b5d' },
  { k: 'exp', label: 'Расходы', color: '#6f86b8' },
  { k: 'loan', label: 'В долг', color: '#8a63b5' },
];
const kindVal = (p: VizPerson, k: Kind) => (k === 'adv' ? n(p.advance) : k === 'sal' ? n(p.salary) : k === 'exp' ? n(p.other) : n(p.loan_given));

export function PeopleViz({ people, serviceNames }: { people: VizPerson[]; serviceNames?: string }) {
  const [off, setOff] = useState<Record<Kind, boolean>>({ adv: false, sal: false, exp: false, loan: false });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const kindTotals = useMemo(() => KINDS.map((K) => ({ ...K, total: people.reduce((a, p) => a + kindVal(p, K.k), 0) })), [people]);
  const grand = kindTotals.reduce((a, K) => a + K.total, 0);

  const rows = useMemo(() => {
    const list = people.map((p) => {
      const vals = { adv: off.adv ? 0 : kindVal(p, 'adv'), sal: off.sal ? 0 : kindVal(p, 'sal'), exp: off.exp ? 0 : kindVal(p, 'exp'), loan: off.loan ? 0 : kindVal(p, 'loan') } as Record<Kind, number>;
      return { p, vals, total: vals.adv + vals.sal + vals.exp + vals.loan, svc: p.employee_id === 'service' };
    }).filter((r) => r.total > 0);
    return [...list.filter((r) => !r.svc).sort((a, b) => b.total - a.total), ...list.filter((r) => r.svc)];
  }, [people, off]);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const shownTotal = rows.reduce((a, r) => a + r.total, 0);

  const showTip = (e: React.MouseEvent, lines: string[]) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, lines });
  };

  if (!people.length) return <div className="empty-state compact">За период расходов и долгов нет.</div>;

  return (
    <div className="pv" ref={wrap} onMouseLeave={() => setTip(null)}>
      <div className="pv-legend">
        {kindTotals.map((K) => (
          <button key={K.k} type="button" className={`pv-chip${off[K.k] ? ' off' : ''}`} onClick={() => setOff({ ...off, [K.k]: !off[K.k] })} title={off[K.k] ? 'Показать' : 'Скрыть'}>
            <i style={{ background: K.color }} /><span>{K.label}</span><b>{rub(K.total)}</b>
          </button>
        ))}
        <div className="pv-chip static"><span>Всего</span><b>{rub(grand)}</b></div>
      </div>
      <p className="pv-hint">Нажмите на цветную плашку, чтобы скрыть или показать вид выдачи. Нажмите на сотрудника, чтобы увидеть записи.</p>

      <div className="pv-rows">
        {rows.map((r, idx) => {
          const key = r.p.employee_id || 'none';
          const isOpen = !!open[key];
          return (
            <div className="pv-item" key={key}>
              <button type="button" className={`pv-row${isOpen ? ' open' : ''}${r.svc ? ' svc' : ''}`} onClick={() => setOpen({ ...open, [key]: !isOpen })}>
                <span className="pv-who">
                  <span className="pv-ava" style={{ background: r.svc ? '#e3e5d8' : avatarBg(r.p.name) }}>{r.svc ? '⚙' : letter(r.p.name)}</span>
                  <b>{r.p.name}{r.svc && serviceNames ? <em> ({serviceNames})</em> : null}</b>
                </span>
                <span className="pv-bar">
                  {KINDS.map((K, ki) => {
                    const v = r.vals[K.k];
                    if (v <= 0) return null;
                    const w = (v / max) * 100;
                    return (
                      <span key={K.k} className="pv-seg" style={{ width: `${w}%`, background: K.color, animationDelay: `${Math.min(idx * 40 + ki * 60, 600)}ms` }}
                        onMouseMove={(e) => showTip(e, [r.p.name, `${K.label}: ${rub(v)}`, `${nf0.format(Math.round((v / r.total) * 100))}% от его суммы`])}>
                        {w > 11 ? compact(v) : ''}
                      </span>
                    );
                  })}
                </span>
                <span className="pv-total"><b>{rub(r.total)}</b></span>
              </button>
              {isOpen && (
                <div className="pv-detail">
                  <div className="pv-brk">{KINDS.map((K) => kindVal(r.p, K.k) > 0 && <span key={K.k}><i style={{ background: K.color }} />{K.label} <b>{rub(kindVal(r.p, K.k))}</b></span>)}</div>
                  {r.p.items.map((it, i) => (
                    <div className="pv-line" key={i}>
                      <span>{dm(it.date)}</span>
                      <span>{it.category}{it.is_loan ? ' (в долг)' : ''}{it.comment ? <em> · {it.comment}</em> : null}</span>
                      <b>{rub(it.amount)}</b>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && <div className="empty-state compact">Все виды скрыты — включите хотя бы один.</div>}
        {rows.length > 0 && <div className="pv-row total"><span className="pv-who"><b>Итого</b></span><span className="pv-bar none" /><span className="pv-total"><b>{rub(shownTotal)}</b></span></div>}
      </div>
      {tip && <div className="pv-tip" style={{ left: tip.x, top: tip.y }}>{tip.lines.map((l, i) => <div key={i} className={i === 0 ? 'h' : ''}>{l}</div>)}</div>}
    </div>
  );
}

/* ───────────────────────────── СТАТЬИ ───────────────────────────── */

const PALETTE = ['#c9822f', '#3e7b5d', '#6f86b8', '#b5495b', '#8a63b5', '#d1b24a', '#4aa3a0'];
const REST = '#a9a794';
const colorOf = (i: number) => (i < PALETTE.length ? PALETTE[i] : REST);

function daysBetween(from: string, to: string) {
  const out: string[] = [];
  const [y1, m1, d1] = iso(from).split('-').map(Number), [y2, m2, d2] = iso(to).split('-').map(Number);
  const a = new Date(y1, m1 - 1, d1), b = new Date(y2, m2 - 1, d2);
  for (let d = a, guard = 0; d <= b && guard < 400; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), guard++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

export function ExpensesViz({ cats, people, from, to }: { cats: VizCategory[]; people: VizPerson[]; from: string; to: string }) {
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [bucketHover, setBucketHover] = useState<number | null>(null);

  const list = useMemo(() => [...cats].sort((a, b) => n(b.amount) - n(a.amount)), [cats]);
  const total = list.reduce((a, c) => a + n(c.amount), 0);
  const entries = useMemo(() => people.flatMap((p) => p.items.filter((i) => !i.is_loan).map((i) => ({ ...i, who: p.employee_id === 'service' ? '' : p.name, date: iso(i.date) }))), [people]);

  const focus = hover ?? sel;
  const focusIdx = focus ? list.findIndex((c) => c.category === focus) : -1;
  const focusCat = focusIdx >= 0 ? list[focusIdx] : null;

  // кольцо
  const R = 78, STROKE = 30, C = 2 * Math.PI * R;
  const slices = useMemo(() => {
    let acc = 0;
    return list.map((c, i) => {
      const frac = total > 0 ? n(c.amount) / total : 0;
      const len = Math.max(0, frac * C - (list.length > 1 ? 2 : 0));
      const s = { c, i, len, start: acc };
      acc += frac * C;
      return s;
    });
  }, [list, total, C]);

  // динамика по дням для выбранной статьи (или всех)
  const timeline = useMemo(() => {
    const days = daysBetween(from, to);
    const size = days.length > 62 ? 7 : 1;
    const buckets: Array<{ label: string; value: number }> = [];
    for (let i = 0; i < days.length; i += size) {
      const chunk = days.slice(i, i + size);
      const set = new Set(chunk);
      const value = entries.filter((e) => set.has(e.date) && (!sel || e.category === sel)).reduce((a, e) => a + n(e.amount), 0);
      buckets.push({ label: size === 1 ? dm(chunk[0]) : `${dm(chunk[0])} – ${dm(chunk[chunk.length - 1])}`, value });
    }
    return buckets;
  }, [entries, from, to, sel]);
  const tMax = Math.max(1, ...timeline.map((b) => b.value));
  const tColor = sel ? colorOf(Math.max(0, list.findIndex((c) => c.category === sel))) : '#7b7764';

  if (!list.length) return <div className="empty-state compact">Расходов за период нет.</div>;

  const selEntries = sel ? entries.filter((e) => e.category === sel).sort((a, b) => a.date.localeCompare(b.date)) : [];

  return (
    <div className="ev">
      <div className="ev-top">
        <div className="ev-donut-wrap">
          <svg viewBox="0 0 200 200" className="ev-donut" role="img" aria-label="Расходы по статьям">
            <g transform="rotate(-90 100 100)">
              <circle cx="100" cy="100" r={R} fill="none" stroke="#eceee3" strokeWidth={STROKE} />
              {slices.map((s) => (
                <circle key={s.c.category} cx="100" cy="100" r={R} fill="none" stroke={colorOf(s.i)} strokeWidth={focus === s.c.category ? STROKE + 6 : STROKE}
                  strokeDasharray={`${s.len} ${C - s.len}`} strokeDashoffset={-s.start} className="ev-slice"
                  style={{ ['--C' as string]: C, opacity: focus && focus !== s.c.category ? 0.35 : 1, animationDelay: `${s.i * 90}ms` } as React.CSSProperties}
                  onMouseEnter={() => setHover(s.c.category)} onMouseLeave={() => setHover(null)} onClick={() => setSel(sel === s.c.category ? null : s.c.category)} />
              ))}
            </g>
          </svg>
          <div className="ev-center">
            {focusCat ? (
              <>
                <small>{focusCat.category}</small>
                <b>{rub(n(focusCat.amount))}</b>
                <em>{total > 0 ? nf1.format((n(focusCat.amount) / total) * 100) : 0}%</em>
              </>
            ) : (
              <>
                <small>Всего</small>
                <b>{rub(total)}</b>
                <em>{list.length} {list.length === 1 ? 'статья' : 'статей'}</em>
              </>
            )}
          </div>
        </div>

        <div className="ev-list">
          {list.map((c, i) => {
            const share = total > 0 ? (n(c.amount) / total) * 100 : 0;
            const on = sel === c.category;
            return (
              <div key={c.category} className={`ev-item${on ? ' on' : ''}${focus && focus !== c.category ? ' dim' : ''}`}>
                <button type="button" className="ev-row" onMouseEnter={() => setHover(c.category)} onMouseLeave={() => setHover(null)} onClick={() => setSel(on ? null : c.category)}>
                  <i className="ev-dot" style={{ background: colorOf(i) }} />
                  <span className="ev-name">{c.category}<small>{c.count} {c.count === 1 ? 'запись' : 'записей'}</small></span>
                  <span className="ev-track"><span style={{ width: `${(n(c.amount) / Math.max(1, n(list[0].amount))) * 100}%`, background: colorOf(i) }} /></span>
                  <b>{rub(n(c.amount))}</b>
                  <em>{share > 0 && share < 1 ? '<1' : Math.round(share)}%</em>
                </button>
                {on && (
                  <div className="ev-detail">
                    {selEntries.map((e, k) => (
                      <div className="ev-line" key={k}><span>{dm(e.date)}</span><span>{e.who || 'Служебная запись'}{e.comment ? <em> · {e.comment}</em> : null}</span><b>{rub(e.amount)}</b></div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <p className="pv-hint">Наведите на кольцо или строку — подсветится статья. Нажмите — увидите записи и график по дням.</p>
        </div>
      </div>

      <div className="ev-time">
        <div className="ev-time-head">
          <b>{sel ? `«${sel}» по дням` : 'Все расходы по дням'}</b>
          <span>{bucketHover !== null && timeline[bucketHover] ? `${timeline[bucketHover].label}: ${rub(timeline[bucketHover].value)}` : sel ? <button type="button" className="pay-link" onClick={() => setSel(null)}>Показать все статьи</button> : 'Наведите на столбик'}</span>
        </div>
        <div className="ev-bars" onMouseLeave={() => setBucketHover(null)}>
          {timeline.map((b, i) => (
            <div key={i} className={`ev-col${bucketHover === i ? ' hov' : ''}`} onMouseEnter={() => setBucketHover(i)} onClick={() => setBucketHover(i)}>
              <span className="ev-bar" style={{ height: `${b.value > 0 ? Math.max(4, (b.value / tMax) * 100) : 0}%`, background: tColor, animationDelay: `${Math.min(i * 12, 450)}ms` }} />
            </div>
          ))}
        </div>
        <div className="ev-axis"><span>{timeline.length ? timeline[0].label.split(' – ')[0] : ''}</span><span>{timeline.length ? timeline[timeline.length - 1].label.split(' – ').slice(-1)[0] : ''}</span></div>
      </div>
    </div>
  );
}
