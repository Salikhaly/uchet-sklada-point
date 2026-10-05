'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// Блок «Зарплата» в Точке. Выплаты хранятся как расходы кассы со статьями
// «Зарплата» / «Аванс» (или любой другой статьёй для «Расход»), поэтому они
// сами попадают в вечернюю сверку и в общие отчёты.
//
// Экран «от сотрудника»: в каждом дне календаря — значки тех, кто что-то брал;
// нажал на сотрудника — календарь показывает его дни и суммы, справа его история
// за месяц (когда и на что). Ненужных сотрудников можно убрать из блока.

type Emp = { id: string; name: string };
type PEmp = Emp & { hidden: boolean };
type Cat = { id: string; name: string };
type Entry = { id: string; date: string; employee_id: string; employee_name: string | null; category: string; amount: number; comment?: string | null; is_loan: boolean; closed: boolean };
type Row = { id: string; name: string; adv: number; sal: number; other: number; items: Entry[] };

const ADV = 'Аванс';
const SAL = 'Зарплата';
const isAdv = (c: string) => c.trim().toLowerCase() === 'аванс';
const isSal = (c: string) => c.trim().toLowerCase() === 'зарплата';
const kindOf = (c: string): 'adv' | 'sal' | 'exp' => (isAdv(c) ? 'adv' : isSal(c) ? 'sal' : 'exp');

const parseNum = (v: unknown) => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const moneyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const money = (v: number) => moneyFmt.format(v) + ' ₸';
const compact = (v: number) => (v >= 1000 ? `${(Math.round(v / 100) / 10).toString().replace('.', ',')}к` : String(Math.round(v)));
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => fmt(new Date());
const monthStart = (iso: string) => iso.slice(0, 7) + '-01';
const monthEnd = (iso: string) => { const [y, m] = iso.split('-').map(Number); return fmt(new Date(y, m, 0)); };
const shiftMonth = (iso: string, n: number) => { const [y, m] = iso.split('-').map(Number); return fmt(new Date(y, m - 1 + n, 1)); };
const monthLabel = (iso: string) => { const [y, m] = iso.split('-').map(Number); const s = new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }); return s.charAt(0).toUpperCase() + s.slice(1); };
const monthName = (iso: string) => { const [y, m] = iso.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long' }); };
const longDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }); };
const rowDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' }); };
const shortDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const avatarBg = (name: string) => `hsl(${hue(name)} 45% 86%)`;
const letter = (name: string) => (name.trim().charAt(0) || '?').toUpperCase();

function parseEntries(data: unknown): Entry[] {
  const list = ((data as { entries?: unknown[] } | null)?.entries || []) as Array<Record<string, unknown>>;
  return list.map((e) => ({
    id: String(e.id), date: String(e.date).slice(0, 10), employee_id: String(e.employee_id),
    employee_name: (e.employee_name as string | null) ?? null, category: String(e.category), amount: Number(e.amount) || 0,
    comment: (e.comment as string | null) ?? null, is_loan: !!e.is_loan, closed: !!e.closed,
  }));
}
function parseEmployees(data: unknown): PEmp[] | null {
  const list = (data as { employees?: unknown[] } | null)?.employees;
  if (!Array.isArray(list)) return null;
  return (list as Array<Record<string, unknown>>).map((e) => ({ id: String(e.id), name: String(e.name), hidden: !!e.hidden }));
}

function summarize(list: Entry[]): Row[] {
  const map = new Map<string, Row>();
  for (const e of list) {
    if (e.is_loan) continue; // долги — отдельная история, к зарплате не относятся
    const r = map.get(e.employee_id) || { id: e.employee_id, name: e.employee_name || 'Без имени', adv: 0, sal: 0, other: 0, items: [] };
    const k = kindOf(e.category);
    if (k === 'adv') r.adv += e.amount; else if (k === 'sal') r.sal += e.amount; else r.other += e.amount;
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
  const [pEmps, setPEmps] = useState<PEmp[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editList, setEditList] = useState(false);
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
    if (error) {
      notify(error.message);
      setPEmps((cur) => (cur.length ? cur : employees.map((e) => ({ ...e, hidden: false }))));
      setLoaded(true);
      return;
    }
    setEntries(parseEntries(data));
    const emps = parseEmployees(data);
    if (emps) setPEmps(emps);
    setLoaded(true);
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

  // ── сотрудники: видимые / скрытые ──
  const hiddenIds = useMemo(() => new Set(pEmps.filter((e) => e.hidden).map((e) => e.id)), [pEmps]);
  const visibleEmps = useMemo(() => pEmps.filter((e) => !e.hidden), [pEmps]);
  const hiddenEmps = useMemo(() => pEmps.filter((e) => e.hidden), [pEmps]);
  const nameOf = (id: string) => pEmps.find((e) => e.id === id)?.name || entries.find((e) => e.employee_id === id)?.employee_name || '?';

  async function setHidden(id: string, hidden: boolean) {
    const { error } = await supabase.rpc('point_set_employee_payroll_hidden', { p_employee_id: id, p_hidden: hidden });
    if (error) return notify(error.message);
    setPEmps((list) => list.map((e) => (e.id === id ? { ...e, hidden } : e)));
    if (hidden && selEmp === id) setSelEmp('');
    notify(hidden ? `${nameOf(id)} убран из блока «Зарплата»` : `${nameOf(id)} возвращён`);
  }

  async function pay(kind: 'adv' | 'sal' | 'exp') {
    if (!selEmp) return notify('Сначала выберите сотрудника');
    const sum = parseNum(amount);
    if (sum <= 0) return notify('Введите сумму');
    const category = kind === 'adv' ? ADV : kind === 'sal' ? SAL : expCat;
    if (!category) return notify('Выберите статью расхода');
    setBusy(true);
    const { error } = await supabase.rpc('point_pay_employee', { p_date: selDate, p_employee_id: selEmp, p_category: category, p_amount: sum, p_comment: comment.trim() || null });
    setBusy(false);
    if (error) return notify(error.message);
    notify(`${category}: ${nameOf(selEmp)} — ${money(sum)} ✅`);
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

  // ── данные месяца (без скрытых сотрудников и долгов) ──
  const vEntries = useMemo(() => entries.filter((e) => !e.is_loan && !hiddenIds.has(e.employee_id)), [entries, hiddenIds]);
  const byDay = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of vEntries) { const l = m.get(e.date); if (l) l.push(e); else m.set(e.date, [e]); }
    return m;
  }, [vEntries]);

  // ── календарь ──
  const [cy, cm] = month.split('-').map(Number);
  const lead = (new Date(cy, cm - 1, 1).getDay() + 6) % 7; // понедельник первым
  const daysInMonth = new Date(cy, cm, 0).getDate();
  const cells: Array<string | null> = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => `${month.slice(0, 7)}-${pad(i + 1)}`)];
  const canNext = monthStart(month) < monthStart(today());

  function cellContent(iso: string) {
    const list = byDay.get(iso) || [];
    if (selEmp) {
      const mine = list.filter((e) => e.employee_id === selEmp);
      if (!mine.length) return null;
      const total = mine.reduce((s, e) => s + e.amount, 0);
      const kind = mine.some((e) => isSal(e.category)) ? 'sal' : mine.some((e) => isAdv(e.category)) ? 'adv' : 'exp';
      return <span className={`pay-amt ${kind}`}>{compact(total)}</span>;
    }
    const ids = [...new Set(list.map((e) => e.employee_id))];
    if (!ids.length) return null;
    return (
      <span className="pay-minis">
        {ids.slice(0, 3).map((id) => <i key={id} className="pay-mini" style={{ background: avatarBg(nameOf(id)) }} title={nameOf(id)}>{letter(nameOf(id))}</i>)}
        {ids.length > 3 && <i className="pay-mini more">+{ids.length - 3}</i>}
      </span>
    );
  }
  const dayClass = (iso: string) => {
    const mine = selEmp && (byDay.get(iso) || []).some((e) => e.employee_id === selEmp);
    return `pay-day${iso === selDate ? ' sel' : ''}${iso === today() ? ' today' : ''}${mine ? ' mine' : ''}`;
  };

  // ── выбранный сотрудник за месяц ──
  const empEntries = useMemo(() => (selEmp ? vEntries.filter((e) => e.employee_id === selEmp) : []), [vEntries, selEmp]);
  const empTot = empEntries.reduce((t, e) => { const k = kindOf(e.category); t[k] += e.amount; return t; }, { adv: 0, sal: 0, exp: 0 });

  // ── выдача за выбранный день (когда сотрудник не выбран) ──
  const dayRows = useMemo(() => summarize(byDay.get(selDate) || []), [byDay, selDate]);
  const dayAdv = dayRows.reduce((s, r) => s + r.adv, 0);
  const daySal = dayRows.reduce((s, r) => s + r.sal, 0);
  const dayOther = dayRows.reduce((s, r) => s + r.other, 0);

  // ── отчёт ──
  const repRows = useMemo(() => summarize(repEntries.filter((e) => !hiddenIds.has(e.employee_id))), [repEntries, hiddenIds]);
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

  const entryRow = (e: Entry, withDate: boolean) => (
    <div key={e.id} className={`pay-entry${e.date === selDate ? ' cur' : ''}`}>
      {withDate
        ? <button type="button" className="pay-date" onClick={() => setSelDate(e.date)}>{rowDate(e.date)}</button>
        : null}
      <span className="pay-what"><i className={`pay-dot ${kindOf(e.category)}`} />{e.category}{e.comment ? <em> · {e.comment}</em> : null}</span>
      <b>{money(e.amount)}</b>
      {e.closed
        ? <span className="muted" title="День закрыт">🔒</span>
        : <span className="pay-entry-actions"><button type="button" title="Изменить сумму" onClick={() => editAmount(e)}>✏️</button><button type="button" title="Удалить" onClick={() => removeEntry(e)}>🗑</button></span>}
    </div>
  );

  return (
    <section className="pay-screen">
      <div className="point-book">
        <div className="book-title">
          <div>
            <div className="eyebrow">ЗАРПЛАТА</div>
            <h2>{view === 'day' ? 'Кто сколько взял' : 'Отчёт по зарплате'}</h2>
            <span>{view === 'day' ? 'В днях календаря — значки тех, кто что-то брал. Нажмите на сотрудника, чтобы увидеть его выплаты по месяцу. Деньги списываются из кассы за выбранный день.' : 'Кто сколько взял за период: аванс, зарплата, прочие расходы.'}</span>
          </div>
          <div className="period-chips">
            <button type="button" className={`chip${view === 'day' ? ' on' : ''}`} onClick={() => setView('day')}>Календарь</button>
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
                ? <button key={iso} type="button" disabled={iso > today()} className={dayClass(iso)} onClick={() => setSelDate(iso)}>
                    <span className="pay-num">{Number(iso.slice(8))}</span>
                    {cellContent(iso)}
                  </button>
                : <span key={`e${i}`} />)}
            </div>
            {selEmp && (
              <div className="pay-legend">
                <span><i className="pay-dot adv" />Аванс</span><span><i className="pay-dot sal" />Зарплата</span><span><i className="pay-dot exp" />Расход</span>
              </div>
            )}

            <div className="pay-sub-row">
              <div className="pay-sub">Сотрудники</div>
              <button type="button" className="pay-link" onClick={() => setEditList(!editList)}>{editList ? 'Готово' : 'Изменить список'}</button>
            </div>
            {!loaded && <span className="muted">Загрузка…</span>}
            {loaded && visibleEmps.length === 0 && <span className="muted">Сотрудников нет{hiddenEmps.length ? ' — все скрыты, нажмите «Изменить список».' : '. Добавьте их на вкладке «Рабочий день».'}</span>}
            <div className="pay-people">
              {visibleEmps.map((e) => (
                <div key={e.id} className="pay-person-wrap">
                  <button type="button" className={`pay-person${selEmp === e.id ? ' on' : ''}`} onClick={() => setSelEmp(selEmp === e.id ? '' : e.id)}>
                    <span className="pay-avatar" style={{ background: avatarBg(e.name) }}>{letter(e.name)}</span>
                    <small>{e.name}</small>
                  </button>
                  {editList && <button type="button" className="pay-x" title="Убрать из блока «Зарплата»" onClick={() => setHidden(e.id, true)}>✕</button>}
                </div>
              ))}
            </div>
            {editList && (
              <div className="pay-hidden">
                <p className="muted">✕ убирает сотрудника только из этого экрана. Сам сотрудник, его расходы и бот не затрагиваются.</p>
                {hiddenEmps.length > 0 && <div className="pay-sub">Убраны</div>}
                <div className="pay-people">
                  {hiddenEmps.map((e) => (
                    <div key={e.id} className="pay-person-wrap dim">
                      <div className="pay-person">
                        <span className="pay-avatar" style={{ background: avatarBg(e.name) }}>{letter(e.name)}</span>
                        <small>{e.name}</small>
                      </div>
                      <button type="button" className="pay-x back" title="Вернуть" onClick={() => setHidden(e.id, false)}>＋</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="panel pay-right">
            {selEmp ? (
              <>
                <div className="pay-emp-top">
                  <span className="pay-avatar" style={{ background: avatarBg(nameOf(selEmp)) }}>{letter(nameOf(selEmp))}</span>
                  <div>
                    <b className="pay-emp-name">{nameOf(selEmp)}</b>
                    <span className="muted">{monthName(month)}: всего взял <b>{money(empTot.adv + empTot.sal + empTot.exp)}</b></span>
                  </div>
                  <button type="button" className="pay-link" onClick={() => setSelEmp('')}>Снять выбор</button>
                </div>
                <div className="pay-chips">
                  <span><i className="pay-dot adv" />Аванс <b>{money(empTot.adv)}</b></span>
                  <span><i className="pay-dot sal" />Зарплата <b>{money(empTot.sal)}</b></span>
                  <span><i className="pay-dot exp" />Расход <b>{money(empTot.exp)}</b></span>
                </div>

                <div className="pay-form">
                  <div className="pay-sub">Добавить на {longDate(selDate)}</div>
                  <div className="pay-inputs">
                    <input inputMode="decimal" placeholder="Сумма, ₸" value={amount} onChange={(e) => setAmount(e.target.value)} />
                    <input placeholder="На что / комментарий" value={comment} onChange={(e) => setComment(e.target.value)} />
                  </div>
                  <div className="pay-actions">
                    <button type="button" className="primary" disabled={busy} onClick={() => pay('adv')}>Аванс</button>
                    <button type="button" className="primary" disabled={busy} onClick={() => pay('sal')}>Зарплата</button>
                    <button type="button" className="pay-ghost" disabled={busy} onClick={() => pay('exp')}>Расход</button>
                  </div>
                  <label className="pay-cat">Статья для «Расход»
                    <select value={expCat} onChange={(e) => setExpCat(e.target.value)}>
                      {expenseCats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                    </select>
                  </label>
                </div>

                <div className="pay-sub">История за {monthName(month)}</div>
                {empEntries.length === 0 && <p className="muted">В этом месяце выплат нет.</p>}
                <div className="pay-list">{empEntries.map((e) => entryRow(e, true))}</div>
              </>
            ) : (
              <>
                <div className="pay-day-head">
                  <b>{longDate(selDate)}</b>
                  <div className="pay-chips">
                    <span><i className="pay-dot adv" />Аванс <b>{money(dayAdv)}</b></span>
                    <span><i className="pay-dot sal" />Зарплата <b>{money(daySal)}</b></span>
                    {dayOther > 0 && <span><i className="pay-dot exp" />Расход <b>{money(dayOther)}</b></span>}
                  </div>
                </div>
                {dayRows.length === 0 && <p className="muted">В этот день никто ничего не брал. Нажмите на сотрудника слева, чтобы выдать или посмотреть его историю.</p>}
                <div className="pay-list">
                  {dayRows.map((r) => (
                    <div key={r.id} className="pay-emp">
                      <button type="button" className="pay-emp-head" onClick={() => setSelEmp(r.id)} title="Открыть историю сотрудника">
                        <span className="pay-avatar sm" style={{ background: avatarBg(r.name) }}>{letter(r.name)}</span>
                        <b>{r.name}</b>
                        <strong>{money(r.adv + r.sal + r.other)}</strong>
                      </button>
                      {r.items.map((e) => entryRow(e, false))}
                    </div>
                  ))}
                </div>
              </>
            )}
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
