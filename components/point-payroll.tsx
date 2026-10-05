'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// Блок «Зарплата» в Точке. Выплаты хранятся как расходы кассы со статьями
// «Зарплата» / «Аванс» (или любой другой статьёй для «Расход»), поэтому они
// сами попадают в вечернюю сверку и в общие отчёты.

type Emp = { id: string; name: string };
type Cat = { id: string; name: string };
type Entry = { id: string; date: string; employee_id: string; employee_name: string | null; category: string; amount: number; comment?: string | null; is_loan: boolean; closed: boolean };
type Row = { id: string; name: string; adv: number; sal: number; other: number; items: Entry[] };

const ADV = 'Аванс';
const SAL = 'Зарплата';
const isAdv = (c: string) => c.trim().toLowerCase() === 'аванс';
const isSal = (c: string) => c.trim().toLowerCase() === 'зарплата';

const parseNum = (v: unknown) => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const moneyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const money = (v: number) => moneyFmt.format(v) + ' ₸';
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => fmt(new Date());
const monthStart = (iso: string) => iso.slice(0, 7) + '-01';
const monthEnd = (iso: string) => { const [y, m] = iso.split('-').map(Number); return fmt(new Date(y, m, 0)); };
const shiftMonth = (iso: string, n: number) => { const [y, m] = iso.split('-').map(Number); return fmt(new Date(y, m - 1 + n, 1)); };
const monthLabel = (iso: string) => { const [y, m] = iso.split('-').map(Number); const s = new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }); return s.charAt(0).toUpperCase() + s.slice(1); };
const longDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }); };
const shortDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };

function parseEntries(data: unknown): Entry[] {
  const list = ((data as { entries?: unknown[] } | null)?.entries || []) as Array<Record<string, unknown>>;
  return list.map((e) => ({
    id: String(e.id), date: String(e.date).slice(0, 10), employee_id: String(e.employee_id),
    employee_name: (e.employee_name as string | null) ?? null, category: String(e.category), amount: Number(e.amount) || 0,
    comment: (e.comment as string | null) ?? null, is_loan: !!e.is_loan, closed: !!e.closed,
  }));
}

function summarize(list: Entry[]): Row[] {
  const map = new Map<string, Row>();
  for (const e of list) {
    if (e.is_loan) continue; // долги — отдельная история, к зарплате не относятся
    const r = map.get(e.employee_id) || { id: e.employee_id, name: e.employee_name || 'Без имени', adv: 0, sal: 0, other: 0, items: [] };
    if (isAdv(e.category)) r.adv += e.amount; else if (isSal(e.category)) r.sal += e.amount; else r.other += e.amount;
    r.items.push(e);
    map.set(e.employee_id, r);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export default function PointPayroll({ employees, categories, notify, onChanged }: {
  employees: Emp[]; categories: Cat[]; notify: (m: string) => void; onChanged?: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [view, setView] = useState<'day' | 'report'>('day');
  const [month, setMonth] = useState(() => monthStart(today()));
  const [selDate, setSelDate] = useState(today());
  const [selEmp, setSelEmp] = useState('');
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [expCat, setExpCat] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState<'this' | 'prev' | 'custom'>('this');
  const [from, setFrom] = useState(() => monthStart(today()));
  const [to, setTo] = useState(today());
  const [repEntries, setRepEntries] = useState<Entry[]>([]);
  const [openEmp, setOpenEmp] = useState<Record<string, boolean>>({});

  const expenseCats = useMemo(() => categories.filter((c) => !isAdv(c.name) && !isSal(c.name)), [categories]);
  useEffect(() => {
    if (!expCat || !expenseCats.some((c) => c.name === expCat)) setExpCat(expenseCats.find((c) => c.name === 'Прочее')?.name || expenseCats[0]?.name || '');
  }, [expenseCats, expCat]);

  const range = useMemo(() => {
    if (period === 'this') return { f: monthStart(today()), t: monthEnd(today()) };
    if (period === 'prev') { const p = shiftMonth(monthStart(today()), -1); return { f: p, t: monthEnd(p) }; }
    return { f: from, t: to };
  }, [period, from, to]);

  async function loadMonth() {
    const { data, error } = await supabase.rpc('point_get_payroll', { p_from: monthStart(month), p_to: monthEnd(month) });
    if (error) { notify(error.message); return; }
    setEntries(parseEntries(data));
  }
  async function loadReport() {
    if (range.t < range.f) { setRepEntries([]); return; }
    const { data, error } = await supabase.rpc('point_get_payroll', { p_from: range.f, p_to: range.t });
    if (error) { notify(error.message); return; }
    setRepEntries(parseEntries(data));
  }
  useEffect(() => { loadMonth(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (view === 'report') loadReport(); }, [view, range.f, range.t]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refresh() { await loadMonth(); if (view === 'report') await loadReport(); onChanged?.(); }

  async function pay(kind: 'adv' | 'sal' | 'exp') {
    if (!selEmp) return notify('Сначала выберите сотрудника (кружок под календарём)');
    const sum = parseNum(amount);
    if (sum <= 0) return notify('Введите сумму');
    const category = kind === 'adv' ? ADV : kind === 'sal' ? SAL : expCat;
    if (!category) return notify('Выберите статью расхода');
    setBusy(true);
    const { error } = await supabase.rpc('point_pay_employee', { p_date: selDate, p_employee_id: selEmp, p_category: category, p_amount: sum, p_comment: comment.trim() || null });
    setBusy(false);
    if (error) return notify(error.message);
    const who = employees.find((e) => e.id === selEmp)?.name || '';
    notify(`${category}: ${who} — ${money(sum)} ✅`);
    setAmount(''); setComment('');
    await refresh();
  }
  async function editAmount(e: Entry) {
    const raw = window.prompt(`Новая сумма: ${e.employee_name} — ${e.category}`, String(e.amount));
    if (raw === null) return;
    const sum = parseNum(raw);
    if (sum <= 0) return notify('Нужна сумма больше нуля');
    const { error } = await supabase.rpc('point_update_evening_expense', { p_expense_id: e.id, p_employee_id: e.employee_id, p_category: e.category, p_comment: e.comment || '', p_amount: sum, p_is_loan: false });
    if (error) return notify(error.message);
    notify('Сумма изменена ✅');
    await refresh();
  }
  async function removeEntry(e: Entry) {
    if (!window.confirm(`Удалить запись: ${e.employee_name} — ${e.category} ${money(e.amount)}?`)) return;
    const { error } = await supabase.rpc('point_remove_evening_expense', { p_expense_id: e.id });
    if (error) return notify(error.message);
    notify('Запись удалена');
    await refresh();
  }

  // ── календарь ──
  const [cy, cm] = month.split('-').map(Number);
  const lead = (new Date(cy, cm - 1, 1).getDay() + 6) % 7; // понедельник первым
  const daysInMonth = new Date(cy, cm, 0).getDate();
  const cells: Array<string | null> = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => `${month.slice(0, 7)}-${pad(i + 1)}`)];
  const marked = useMemo(() => new Set(entries.filter((e) => !e.is_loan).map((e) => e.date)), [entries]);
  const canNext = monthStart(month) < monthStart(today());

  // ── выдача за выбранный день ──
  const dayRows = useMemo(() => summarize(entries.filter((e) => e.date === selDate)), [entries, selDate]);
  const dayAdv = dayRows.reduce((s, r) => s + r.adv, 0);
  const daySal = dayRows.reduce((s, r) => s + r.sal, 0);
  const dayOther = dayRows.reduce((s, r) => s + r.other, 0);

  // ── отчёт ──
  const repRows = useMemo(() => summarize(repEntries), [repEntries]);
  const repTot = repRows.reduce((t, r) => ({ adv: t.adv + r.adv, sal: t.sal + r.sal, other: t.other + r.other }), { adv: 0, sal: 0, other: 0 });

  async function exportXlsx() {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const sheet = (rows: Array<Array<string | number>>, widths: number[]) => { const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = widths.map((w) => ({ wch: w })); return ws; };
    XLSX.utils.book_append_sheet(wb, sheet([
      [`Зарплата: ${range.f} — ${range.t}`], [],
      ['Сотрудник', 'Аванс, ₸', 'Зарплата, ₸', 'Выдано всего, ₸', 'Прочие расходы, ₸'],
      ...repRows.map((r) => [r.name, r.adv, r.sal, r.adv + r.sal, r.other]),
      [], ['Итого', repTot.adv, repTot.sal, repTot.adv + repTot.sal, repTot.other],
    ], [26, 14, 14, 18, 18]), 'Итоги');
    XLSX.utils.book_append_sheet(wb, sheet([
      ['Дата', 'Сотрудник', 'Вид', 'Сумма, ₸', 'Комментарий'],
      ...repRows.flatMap((r) => r.items.map((e) => [e.date, r.name, e.category, e.amount, e.comment || ''])),
    ], [12, 24, 18, 14, 36]), 'По записям');
    XLSX.writeFile(wb, `zarplata_${range.f}_${range.t}.xlsx`);
  }

  const dayMark = (iso: string) => `pay-day${iso === selDate ? ' sel' : ''}${marked.has(iso) ? ' has' : ''}${iso === today() ? ' today' : ''}`;

  return (
    <section className="pay-screen">
      <div className="point-book">
        <div className="book-title">
          <div>
            <div className="eyebrow">ЗАРПЛАТА</div>
            <h2>{view === 'day' ? 'Выдача сотрудникам' : 'Отчёт по зарплате'}</h2>
            <span>{view === 'day' ? 'Выберите день, сотрудника и нажмите «Аванс», «Зарплата» или «Расход». Деньги списываются из кассы за этот день.' : 'Кто сколько взял за период: аванс, зарплата, прочие расходы.'}</span>
          </div>
          <div className="period-chips">
            <button type="button" className={`chip${view === 'day' ? ' on' : ''}`} onClick={() => setView('day')}>Выдача</button>
            <button type="button" className={`chip${view === 'report' ? ' on' : ''}`} onClick={() => setView('report')}>Отчёт</button>
          </div>
        </div>
      </div>

      {view === 'day' && (
        <div className="pay-grid">
          <div className="panel pay-left">
            <div className="pay-month">
              <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Предыдущий месяц">‹</button>
              <b>{monthLabel(month)}</b>
              <button type="button" disabled={!canNext} onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Следующий месяц">›</button>
            </div>
            <div className="pay-cal">
              {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => <span key={d} className="pay-wd">{d}</span>)}
              {cells.map((iso, i) => iso
                ? <button key={iso} type="button" disabled={iso > today()} className={dayMark(iso)} onClick={() => setSelDate(iso)}>{Number(iso.slice(8))}</button>
                : <span key={`e${i}`} />)}
            </div>

            <div className="pay-sub">Сотрудник</div>
            <div className="pay-people">
              {employees.length === 0 && <span className="muted">Сотрудников пока нет. Добавьте их на вкладке «Рабочий день».</span>}
              {employees.map((e) => (
                <button key={e.id} type="button" className={`pay-person${selEmp === e.id ? ' on' : ''}`} onClick={() => setSelEmp(selEmp === e.id ? '' : e.id)}>
                  <span className="pay-avatar" style={{ background: `hsl(${hue(e.name)} 45% 86%)` }}>{e.name.trim().charAt(0).toUpperCase()}</span>
                  <small>{e.name}</small>
                </button>
              ))}
            </div>

            <div className="pay-form">
              <div className="pay-sub">{selEmp ? `${employees.find((e) => e.id === selEmp)?.name} · ${longDate(selDate)}` : 'Выберите сотрудника'}</div>
              <input inputMode="decimal" placeholder="Сумма, ₸" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <input placeholder="Комментарий (необязательно)" value={comment} onChange={(e) => setComment(e.target.value)} />
              <div className="pay-actions">
                <button type="button" className="primary" disabled={busy || !selEmp} onClick={() => pay('adv')}>Аванс</button>
                <button type="button" className="primary" disabled={busy || !selEmp} onClick={() => pay('sal')}>Зарплата</button>
                <button type="button" className="pay-ghost" disabled={busy || !selEmp} onClick={() => pay('exp')}>Расход</button>
              </div>
              <label className="pay-cat">Статья для «Расход»
                <select value={expCat} onChange={(e) => setExpCat(e.target.value)}>
                  {expenseCats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </label>
            </div>
          </div>

          <div className="panel pay-right">
            <div className="pay-day-head">
              <b>{longDate(selDate)}</b>
              <div className="pay-chips">
                <span>Аванс <b>{money(dayAdv)}</b></span>
                <span>Зарплата <b>{money(daySal)}</b></span>
                {dayOther > 0 && <span>Расход <b>{money(dayOther)}</b></span>}
              </div>
            </div>
            {dayRows.length === 0 && <p className="muted">В этот день ничего не выдавали.</p>}
            <div className="pay-list">
              {dayRows.map((r) => (
                <div key={r.id} className="pay-emp">
                  <div className="pay-emp-head">
                    <span className="pay-avatar sm" style={{ background: `hsl(${hue(r.name)} 45% 86%)` }}>{r.name.charAt(0).toUpperCase()}</span>
                    <b>{r.name}</b>
                    <strong>{money(r.adv + r.sal + r.other)}</strong>
                  </div>
                  {r.items.map((e) => (
                    <div key={e.id} className="pay-entry">
                      <span>{e.category}{e.comment ? <em> · {e.comment}</em> : null}</span>
                      <b>{money(e.amount)}</b>
                      {e.closed
                        ? <span className="muted" title="День закрыт">🔒</span>
                        : <span className="pay-entry-actions"><button type="button" title="Изменить сумму" onClick={() => editAmount(e)}>✏️</button><button type="button" title="Удалить" onClick={() => removeEntry(e)}>🗑</button></span>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {view === 'report' && (
        <div className="panel pay-report">
          <div className="report-toolbar">
            <div className="period-chips">
              <button type="button" className={`chip${period === 'this' ? ' on' : ''}`} onClick={() => setPeriod('this')}>Этот месяц</button>
              <button type="button" className={`chip${period === 'prev' ? ' on' : ''}`} onClick={() => setPeriod('prev')}>Прошлый месяц</button>
              <button type="button" className={`chip${period === 'custom' ? ' on' : ''}`} onClick={() => setPeriod('custom')}>Свой период</button>
            </div>
            {period === 'custom' && (
              <div className="report-dates">
                <label>С<input type="date" value={from} max={today()} onChange={(e) => setFrom(e.target.value)} /></label>
                <label>По<input type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} /></label>
              </div>
            )}
            <button type="button" className="primary" disabled={!repRows.length} onClick={exportXlsx}>Скачать Excel</button>
          </div>
          <p className="muted">{range.f} — {range.t}</p>
          <div className="pay-table-wrap">
            <table className="data-table">
              <thead><tr><th>Сотрудник</th><th>Аванс</th><th>Зарплата</th><th>Выдано всего</th><th>Прочие расходы</th></tr></thead>
              <tbody>
                {repRows.length === 0 && <tr><td colSpan={5} className="muted">За этот период выплат нет.</td></tr>}
                {repRows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className="pay-row" onClick={() => setOpenEmp({ ...openEmp, [r.id]: !openEmp[r.id] })}>
                      <td><b>{openEmp[r.id] ? '▾' : '▸'} {r.name}</b></td>
                      <td>{money(r.adv)}</td><td>{money(r.sal)}</td><td><b>{money(r.adv + r.sal)}</b></td><td>{money(r.other)}</td>
                    </tr>
                    {openEmp[r.id] && r.items.map((e) => (
                      <tr key={e.id} className="pay-detail"><td colSpan={5}>{shortDate(e.date)} · {e.category} · <b>{money(e.amount)}</b>{e.comment ? ` · ${e.comment}` : ''}</td></tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
              {repRows.length > 0 && <tfoot><tr><td><b>Итого</b></td><td><b>{money(repTot.adv)}</b></td><td><b>{money(repTot.sal)}</b></td><td><b>{money(repTot.adv + repTot.sal)}</b></td><td><b>{money(repTot.other)}</b></td></tr></tfoot>}
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
