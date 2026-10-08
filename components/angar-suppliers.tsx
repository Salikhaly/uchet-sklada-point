'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { SRow } from './angar-client-profit';

// Поставщики: от кого именно и что именно.
//  • «По поставщикам» — у каждого полоса-состав (какие металлы он привозит и в каком объёме), цена против других
//    поставщиков того же металла, последняя поставка, последние приходы.
//  • «По металлам» — по каждому металлу: кто именно его привозит, доли, цены, кто дешевле, сколько можно было сэкономить.

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const rub = (v: number) => nf0.format(Math.round(v)) + ' ₸';
const compact = (v: number) => { const a = Math.abs(v); const s = a >= 1e6 ? `${nf1.format(a / 1e6)} млн` : a >= 1e3 ? `${nf0.format(a / 1e3)} тыс` : nf0.format(a); return (v < 0 ? '−' : '') + s + ' ₸'; };
const signed = (v: number) => (Math.abs(v) < 1 ? '0 ₸' : (v > 0 ? '+' : '−') + compact(Math.abs(v)));
const price = (v: number) => (v >= 1000 ? nf0 : nf1).format(v) + ' ₸/кг';
const kgf = (v: number) => nf0.format(v) + ' кг';
const pc = (v: number) => nf1.format(v) + '%';
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const plural = (k: number, one: string, few: string, many: string) => { const a = Math.abs(k) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
const iso = (s: string) => String(s).slice(0, 10);
const dm = (s: string) => `${iso(s).slice(8, 10)}.${iso(s).slice(5, 7)}`;
const ago = (s: string | null) => {
  if (!s) return '';
  const [y, m, d] = iso(s).split('-').map(Number);
  const days = Math.round((Date.now() - new Date(y, m - 1, d).getTime()) / 86400000);
  return days <= 0 ? 'сегодня' : days === 1 ? 'вчера' : `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
};

const PALETTE = ['#c9822f', '#3e7b5d', '#6f86b8', '#b5495b', '#8a63b5', '#d1b24a', '#4aa3a0', '#7d8f3b'];
const OTHER = '#b8b5a2';

type MS = { product: string; kg: number; spent: number; avgP: number; minP: number; maxP: number; potential: number; bestKey: string | null; worstKey: string | null; color: string;
  sup: Array<{ key: string; name: string; kg: number; spent: number; price: number; saving: number; exp: number | null }> };

function Ruler({ p, min, max, avg }: { p: number; min: number; max: number; avg: number }) {
  const span = max - min;
  const pos = (v: number) => (span > 0 ? Math.min(100, Math.max(0, ((v - min) / span) * 100)) : 50);
  return (
    <span className="sv-ruler" title={`от ${nf1.format(min)} до ${nf1.format(max)} ₸/кг`}>
      <i className="sv-r-track" />
      <i className="sv-r-avg" style={{ left: `${pos(avg)}%` }} />
      <i className={`sv-r-dot ${p <= avg ? 'good' : 'bad'}`} style={{ left: `${pos(p)}%` }} />
    </span>
  );
}

const Line = ({ l, v }: { l: string; v: ReactNode }) => <div className="mm-line"><span>{l}</span><b>{v}</b></div>;

export function SuppliersView({ rows, onClient }: { rows: SRow[]; onClient?: (name: string) => void }) {
  const [mode, setMode] = useState<'sup' | 'metal'>('sup');
  const [measure, setMeasure] = useState<'spent' | 'saving' | 'exp'>('spent');
  const [sel, setSel] = useState<string | null>(null);
  const [hl, setHl] = useState<string | null>(null);
  const [selMetal, setSelMetal] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const metals = useMemo(() => {
    const m = new Map<string, MS>();
    rows.forEach((r) => r.metals.forEach((x) => {
      const e = m.get(x.product) || { product: x.product, kg: 0, spent: 0, avgP: 0, minP: 0, maxP: 0, potential: 0, bestKey: null, worstKey: null, color: OTHER, sup: [] };
      e.kg += x.kg; e.spent += x.spent;
      e.sup.push({ key: r.key, name: r.name, kg: x.kg, spent: x.spent, price: x.kg > 0 ? x.spent / x.kg : 0, saving: x.saving, exp: x.exp_profit });
      m.set(x.product, e);
    }));
    const list = [...m.values()].sort((a, b) => b.spent - a.spent);
    list.forEach((e, i) => {
      e.color = i < PALETTE.length ? PALETTE[i] : OTHER;
      e.avgP = e.kg > 0 ? e.spent / e.kg : 0;
      // «лучшая/худшая цена» — только среди поставщиков с заметным объёмом, чтобы мелкие партии не искажали
      const sig = e.sup.filter((s) => s.kg >= Math.max(50, e.kg * 0.03));
      const pool = (sig.length ? sig : e.sup).filter((s) => s.price > 0);
      e.minP = pool.length ? Math.min(...pool.map((s) => s.price)) : 0;
      e.maxP = pool.length ? Math.max(...pool.map((s) => s.price)) : 0;
      e.bestKey = pool.find((s) => s.price === e.minP)?.key ?? null;
      e.worstKey = pool.length > 1 ? pool.find((s) => s.price === e.maxP)?.key ?? null : null;
      e.potential = e.sup.reduce((a, s) => a + Math.max(0, s.price - e.minP) * s.kg, 0);
      e.sup.sort((a, b) => b.kg - a.kg);
    });
    return list;
  }, [rows]);
  const metalBy = useMemo(() => new Map(metals.map((m) => [m.product, m])), [metals]);

  const val = (r: SRow) => (measure === 'spent' ? r.spent : measure === 'saving' ? r.saving : r.exp);
  const sorted = useMemo(() => [...rows].sort((a, b) => val(b) - val(a)), [rows, measure]); // eslint-disable-line react-hooks/exhaustive-deps
  const maxSpent = Math.max(1, ...rows.map((r) => r.spent));
  const curMetal = metals.find((m) => m.product === selMetal) ?? metals[0] ?? null;

  const showTip = (e: React.MouseEvent, lines: string[]) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, lines });
  };

  const legend = metals.slice(0, PALETTE.length);

  return (
    <div className="sv" ref={wrap} onMouseLeave={() => setTip(null)}>
      <div className="sv-bar">
        <div className="pc-seg">
          <button type="button" className={mode === 'sup' ? 'on' : ''} onClick={() => setMode('sup')}>По поставщикам</button>
          <button type="button" className={mode === 'metal' ? 'on' : ''} onClick={() => setMode('metal')}>По металлам · кто именно привозит</button>
        </div>
        {mode === 'sup' && (
          <div className="pc-seg">
            <button type="button" className={measure === 'spent' ? 'on' : ''} onClick={() => setMeasure('spent')}>Закуплено ₸</button>
            <button type="button" className={measure === 'saving' ? 'on' : ''} onClick={() => setMeasure('saving')}>Выгода от цены</button>
            <button type="button" className={measure === 'exp' ? 'on' : ''} onClick={() => setMeasure('exp')}>Ожидаемая прибыль</button>
          </div>
        )}
      </div>

      {mode === 'sup' ? (
        <>
          <div className="sv-legend">
            {legend.map((m) => (
              <button key={m.product} type="button" className={`sv-lg${hl && hl !== m.product ? ' off' : ''}`} onClick={() => setHl(hl === m.product ? null : m.product)} title="Подсветить этот металл у всех поставщиков">
                <i style={{ background: m.color }} />{m.product}
              </button>
            ))}
            {metals.length > PALETTE.length && <span className="sv-lg static"><i style={{ background: OTHER }} />другие</span>}
          </div>
          <p className="pv-hint sv-hint">Полоса — из чего состоит закуп у поставщика (длина — сумма, цвета — металлы). Наведите на цвет: сколько и по какой цене. Нажмите на поставщика — детали.</p>

          <div className="sv-list">
            {sorted.map((r, i) => {
              const open = sel === r.key;
              const has = hl ? r.metals.some((m) => m.product === hl) : true;
              return (
                <div key={r.key} className={`mm-item${open ? ' open' : ''}${hl && !has ? ' dim' : ''}`}>
                  <button type="button" className="sv-row" onClick={() => setSel(open ? null : r.key)}>
                    <span className="mm-name"><i style={{ background: `hsl(${hue(r.name)} 50% 55%)` }} /><b>{r.name}</b>
                      <small>{compact(r.spent)} · {kgf(r.kg)} · {r.metals.length} {plural(r.metals.length, 'металл', 'металла', 'металлов')}{r.last_date ? ` · привозил ${ago(r.last_date)}` : ''}{r.members.length > 1 ? ` · ${r.members.length} ${plural(r.members.length, 'контрагент', 'контрагента', 'контрагентов')}` : ''}</small></span>
                    <span className="sv-track"><span className="sv-stack" style={{ width: `${Math.max(3, (r.spent / maxSpent) * 100)}%`, animationDelay: `${Math.min(i * 40, 500)}ms` }}>
                      {r.metals.map((m) => {
                        const ms = metalBy.get(m.product);
                        const p = m.kg > 0 ? m.spent / m.kg : 0;
                        return (
                          <span key={m.product} className="sv-seg" style={{ width: `${(m.spent / Math.max(1, r.spent)) * 100}%`, background: ms?.color ?? OTHER, opacity: hl && hl !== m.product ? 0.22 : 1 }}
                            onMouseMove={(e) => showTip(e, [`${r.name} · ${m.product}`, `${compact(m.spent)} · ${kgf(m.kg)}`, `цена ${price(p)}${ms ? ` (средняя ${price(ms.avgP)})` : ''}`])} />
                        );
                      })}
                    </span></span>
                    <span className="mm-val"><b>{measure === 'spent' ? compact(r.spent) : measure === 'saving' ? signed(r.saving) : compact(r.exp)}</b>
                      <em className={Math.abs(r.saving) < 1 ? '' : r.saving > 0 ? 'ok' : 'warn'}>{Math.abs(r.saving) < 1 ? 'на уровне среднего' : r.saving > 0 ? `дешевле на ${compact(r.saving)}` : `дороже на ${compact(Math.abs(r.saving))}`}</em></span>
                  </button>
                  {open && (
                    <div className="mm-detail">
                      <Line l="Закуплено" v={`${kgf(r.kg)} на ${rub(r.spent)} · ${r.ops} ${plural(r.ops, 'приход', 'прихода', 'приходов')} · в среднем ${price(r.spent / Math.max(1, r.kg))}`} />
                      {r.last_date && <Line l="Последняя поставка" v={`${dm(r.last_date)} (${ago(r.last_date)})`} />}
                      <Line l="Выгода от цены" v={Math.abs(r.saving) < 1 ? 'на уровне средней закупочной цены' : <span className={r.saving > 0 ? 'cp-good' : 'cp-bad'}>{r.saving > 0 ? 'дешевле средней закупочной цены на' : 'дороже средней закупочной цены на'} {compact(Math.abs(r.saving))}</span>} />
                      <Line l="Ожидаемая прибыль" v={<>{compact(r.exp)} <small>(оценено {pc(r.assessedShare)} закупа; остальное ещё не продавалось)</small></>} />

                      <div className="sv-sub">Что именно привозит</div>
                      <div className="cp-tbl-wrap"><table className="cp-tbl sv-tbl"><thead><tr><th>Металл</th><th>кг</th><th>На сумму</th><th>Цена</th><th>Среди поставщиков</th><th>Против средней</th><th>Ожид. прибыль</th></tr></thead>
                        <tbody>{r.metals.map((m) => {
                          const ms = metalBy.get(m.product);
                          const p = m.kg > 0 ? m.spent / m.kg : 0;
                          const d = (ms?.avgP ?? p) - p;
                          return (
                            <tr key={m.product}>
                              <td><i className="sv-dot" style={{ background: ms?.color ?? OTHER }} />{m.product}</td>
                              <td>{nf0.format(m.kg)}</td><td>{compact(m.spent)}</td><td>{nf1.format(p)}</td>
                              <td>{ms && ms.maxP > ms.minP ? <Ruler p={p} min={ms.minP} max={ms.maxP} avg={ms.avgP} /> : <span className="muted">один поставщик</span>}</td>
                              <td className={Math.abs(d) < 0.05 ? '' : d > 0 ? 'cp-good' : 'cp-bad'}>{Math.abs(d) < 0.05 ? '0' : `${d > 0 ? '−' : '+'}${nf1.format(Math.abs(d))} ₸/кг`}{ms && ms.bestKey === r.key && ms.worstKey ? ' ★' : ''}</td>
                              <td>{m.exp_profit == null ? 'не продавался' : compact(m.exp_profit)}</td>
                            </tr>
                          );
                        })}</tbody></table></div>
                      <p className="pv-hint">Линейка: слева самая низкая цена среди поставщиков этого металла, справа самая высокая; чёрточка — средняя; точка — этот поставщик (зелёная — дешевле средней). ★ — самая низкая цена по металлу.</p>

                      {r.recent.length > 0 && (
                        <>
                          <div className="sv-sub">Последние приходы</div>
                          <div className="sv-recent">{r.recent.map((x, k) => (
                            <div key={k} className="sv-rc"><span>{dm(x.date)}</span><span>{x.who ? `${x.who} · ` : ''}{kgf(x.kg)}</span><span>{price(x.amount / Math.max(1, x.kg))}</span><b>{compact(x.amount)}</b></div>
                          ))}</div>
                        </>
                      )}
                      {r.single && onClient && <button type="button" className="pay-link" onClick={() => onClient(r.name)}>Открыть карточку поставщика →</button>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        curMetal && (
          <div className="sv-cols">
            <div className="sv-metals">
              <div className="mm-ph"><b>Металлы</b><span>нажмите — увидите, кто привозит</span></div>
              <div className="sv-mlist">
                {metals.map((m) => (
                  <button key={m.product} type="button" className={`sv-mrow${curMetal.product === m.product ? ' on' : ''}`} onClick={() => setSelMetal(m.product)}>
                    <span className="mm-name"><i style={{ background: m.color }} /><b>{m.product}</b><small>{compact(m.spent)} · {kgf(m.kg)} · {m.sup.length} {plural(m.sup.length, 'поставщик', 'поставщика', 'поставщиков')}</small></span>
                    <span className="sv-range">{m.maxP > m.minP ? <>{nf0.format(m.minP)}–{nf0.format(m.maxP)} <small>₸/кг</small></> : <>{nf0.format(m.avgP)} <small>₸/кг</small></>}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="sv-detail">
              <div className="mp-title">
                <div><b>{curMetal.product}</b></div>
                <span>Закуплено: <b>{kgf(curMetal.kg)}</b> на <b>{rub(curMetal.spent)}</b> · средняя цена <b>{price(curMetal.avgP)}</b> · {curMetal.sup.length} {plural(curMetal.sup.length, 'поставщик', 'поставщика', 'поставщиков')}</span>
                {curMetal.maxP > curMetal.minP && <span>Цена от <b>{price(curMetal.minP)}</b> до <b>{price(curMetal.maxP)}</b> — разброс <b>{pc(((curMetal.maxP - curMetal.minP) / Math.max(1, curMetal.minP)) * 100)}</b></span>}
              </div>
              <div className="sv-share" data-noswipe>
                {curMetal.sup.map((s) => (
                  <span key={s.key} style={{ width: `${(s.kg / Math.max(1, curMetal.kg)) * 100}%`, background: `hsl(${hue(s.name)} 50% 55%)` }}
                    onMouseMove={(e) => showTip(e, [s.name, `${kgf(s.kg)} · ${pc((s.kg / Math.max(1, curMetal.kg)) * 100)} объёма`, `цена ${price(s.price)}`])} />
                ))}
              </div>
              <div className="sv-who">
                {curMetal.sup.map((s, i) => {
                  const d = curMetal.avgP > 0 ? (s.price / curMetal.avgP - 1) * 100 : 0;
                  const best = curMetal.bestKey === s.key, worst = curMetal.worstKey === s.key;
                  return (
                    <div key={s.key} className="sv-wrow">
                      <button type="button" className="sv-wname" onClick={() => { setMode('sup'); setSel(s.key); }} title="Открыть поставщика"><i style={{ background: `hsl(${hue(s.name)} 50% 55%)` }} />{s.name}</button>
                      <span className="sv-wbar"><span style={{ width: `${(s.kg / Math.max(1, curMetal.sup[0].kg)) * 100}%`, background: `hsl(${hue(s.name)} 50% 55%)`, animationDelay: `${Math.min(i * 40, 400)}ms` }} /></span>
                      <span className="sv-wnum">{kgf(s.kg)}<small>{pc((s.kg / Math.max(1, curMetal.kg)) * 100)}</small></span>
                      <span className="sv-wnum"><b>{nf1.format(s.price)}</b><small>₸/кг</small></span>
                      <span className={`sv-wnum ${Math.abs(d) < 0.5 ? '' : d < 0 ? 'cp-good' : 'cp-bad'}`}>{Math.abs(d) < 0.5 ? '≈ средней' : `${d < 0 ? '▼' : '▲'} ${pc(Math.abs(d))}`}<small>{signed(s.saving)}</small></span>
                      <span className="sv-wtag">{best && curMetal.worstKey ? <em className="good">лучшая цена</em> : worst ? <em className="bad">самая высокая</em> : null}</span>
                    </div>
                  );
                })}
              </div>
              {curMetal.potential > 1000 && curMetal.maxP > curMetal.minP && (
                <p className="mp-note sv-pot">Если бы весь объём этого металла шёл по лучшей цене ({price(curMetal.minP)}), закуп был бы дешевле примерно на <b>{compact(curMetal.potential)}</b>. Расчёт среди поставщиков с заметным объёмом; на цену влияют и качество металла, и условия поставки.</p>
              )}
            </div>
          </div>
        )
      )}
      {tip && <div className="pv-tip" style={{ left: tip.x, top: tip.y }}>{tip.lines.map((l, i) => <div key={i} className={i === 0 ? 'h' : ''}>{l}</div>)}</div>}
    </div>
  );
}
