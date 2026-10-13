// FieldForge SPA. Every mutation goes through window.fieldforge.dispatch, so
// the UI and the programmatic API are guaranteed to behave identically.
import ff from './api.js';

const C = ff.core;
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (c) => C.fmtMoney(c || 0);
const S = () => ff.state;
const get = (coll, id) => (id ? C.byId(S(), coll, id) : null);
const pill = (s) => `<span class="pill ${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;
const tradeTag = (t) => `<span class="trade ${t}">${C.TRADE_LABELS[t]}</span>`;
const custLink = (id) => { const c = get('customers', id); return c ? `<a href="#/customers/${c.id}">${esc(c.name)}</a>` : esc(id); };
const techName = (id) => get('technicians', id)?.name ?? '—';
const DAY_START = 420;
const DAY_END = 1080;
const SPAN = DAY_END - DAY_START;

const ui = {
  company: localStorage.getItem('fieldforge:ui:company') || 'CO-1',
  dispatchDate: S().meta.today,
  dispatchTrade: '',
  pages: {},
  filters: {},
};
const companyFilter = () => (ui.company === 'all' ? undefined : ui.company);
const dispatchCompany = () => (ui.company === 'all' ? 'CO-1' : ui.company);

// ---- toasts & modal ---------------------------------------------------------------
function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = `toast${err ? ' err' : ''}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 6000 : 3000);
}

let currentModal = null;
function openModal({ title, body, footer = '', reopen = null, onMount = null }) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-label="${esc(title)}">
    <header><h2>${title}</h2><button class="btn small" data-close>✕</button></header>
    <div class="body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}</div></div>`;
  currentModal = { reopen };
  $('[data-close]', root).onclick = closeModal;
  $('.modal-back', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-back')) closeModal(); });
  if (onMount) onMount($('.modal', root));
}
function closeModal() {
  $('#modal-root').innerHTML = '';
  currentModal = null;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/** Dispatch an action, toast the outcome, refresh. */
function act(type, params, okMsg) {
  const r = ff.dispatch(type, params);
  if (r.ok) {
    if (okMsg) toast(okMsg);
    if (currentModal?.reopen) currentModal.reopen();
  } else toast(`${r.error.code}: ${r.error.message}`, true);
  return r;
}

// ---- generic form ------------------------------------------------------------------
function fieldHtml(f) {
  const v = f.value ?? '';
  const cls = f.full ? ' class="full"' : '';
  if (f.type === 'select') {
    return `<label${cls}>${esc(f.label)}<select name="${f.name}">${f.options.map((o) => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}"${String(val) === String(v) ? ' selected' : ''}>${esc(lab)}</option>`; }).join('')}</select></label>`;
  }
  if (f.type === 'textarea') return `<label${cls}>${esc(f.label)}<textarea name="${f.name}">${esc(v)}</textarea></label>`;
  if (f.type === 'checkbox') return `<label${cls} style="flex-direction:row;align-items:center"><input type="checkbox" name="${f.name}"${v ? ' checked' : ''}> ${esc(f.label)}</label>`;
  if (f.type === 'items') return `<div class="full">${itemsEditor(f.value || [])}</div>`;
  if (f.type === 'html') return `<div class="full">${f.html}</div>`;
  return `<label${cls}>${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}"${f.step ? ` step="${f.step}"` : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}></label>`;
}

function itemRow(it = {}) {
  const opts = C.TRADES.map((t) => `<optgroup label="${C.TRADE_LABELS[t]}">${C.SERVICES.filter((s) => s.trade === t).map((s) => `<option value="${s.code}"${it.code === s.code ? ' selected' : ''}>${s.code} — ${esc(s.name)} (${money(s.priceCents)})</option>`).join('')}</optgroup>`).join('');
  const custom = !it.code || it.code === 'PARTS';
  return `<tr>
    <td><select class="it-code"><option value="">Custom line…</option><option value="PARTS"${it.code === 'PARTS' ? ' selected' : ''}>PARTS — materials</option>${opts}</select>
      <input class="it-desc" placeholder="Description" value="${esc(custom ? it.description || '' : '')}" style="margin-top:4px;${custom ? '' : 'display:none'}"></td>
    <td style="width:70px"><input class="it-qty" type="number" min="1" value="${it.qty || 1}"></td>
    <td style="width:110px"><input class="it-price" type="number" step="0.01" placeholder="price $" value="${custom && it.unitPriceCents != null ? (it.unitPriceCents / 100).toFixed(2) : ''}" style="${custom ? '' : 'display:none'}"></td>
    <td style="width:40px"><button type="button" class="btn small" data-del-item>✕</button></td></tr>`;
}
function itemsEditor(items) {
  return `<table class="items-table"><thead><tr><th>Item</th><th>Qty</th><th>Unit $ (custom)</th><th></th></tr></thead>
    <tbody>${(items.length ? items : [{}]).map(itemRow).join('')}</tbody></table>
    <button type="button" class="btn small" data-add-item style="margin-top:6px">+ Add line</button>`;
}
function wireItems(root) {
  root.addEventListener('click', (e) => {
    if (e.target.matches('[data-add-item]')) $('.items-table tbody', root).insertAdjacentHTML('beforeend', itemRow());
    if (e.target.matches('[data-del-item]')) e.target.closest('tr').remove();
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('.it-code')) {
      const tr = e.target.closest('tr');
      const custom = !e.target.value || e.target.value === 'PARTS';
      $('.it-desc', tr).style.display = custom ? '' : 'none';
      $('.it-price', tr).style.display = custom ? '' : 'none';
      if (e.target.value === 'PARTS' && !$('.it-desc', tr).value) $('.it-desc', tr).value = 'Materials & parts';
    }
  });
}
function readItems(root) {
  return $$('.items-table tbody tr', root).map((tr) => {
    const code = $('.it-code', tr).value;
    const qty = Number($('.it-qty', tr).value) || 1;
    if (code && code !== 'PARTS') return { code, qty };
    return { code: code || undefined, description: $('.it-desc', tr).value, qty, unitPriceCents: Math.round(parseFloat($('.it-price', tr).value || '0') * 100) };
  });
}

function openForm({ title, fields, submitLabel = 'Save', onSubmit }) {
  openModal({
    title,
    body: `<form class="form">${fields.map(fieldHtml).join('')}</form><div class="form-error"></div>`,
    footer: `<button class="btn" data-close2>Cancel</button><button class="btn primary" data-submit>${esc(submitLabel)}</button>`,
    onMount(m) {
      wireItems(m);
      $('[data-close2]', m).onclick = closeModal;
      $('[data-submit]', m).onclick = () => {
        const values = {};
        for (const f of fields) {
          if (f.type === 'items') { values[f.name] = readItems(m); continue; }
          const el = $(`[name="${f.name}"]`, m);
          if (!el) continue;
          values[f.name] = f.type === 'checkbox' ? el.checked : el.value;
        }
        const r = onSubmit(values);
        if (r && r.ok === false) $('.form-error', m).textContent = `${r.error.code}: ${r.error.message}`;
      };
      const first = $('input,select', m);
      if (first) first.focus();
    },
  });
}

// ---- table helper ---------------------------------------------------------------------
function table(key, rows, columns, { pageSize = 50, onRow } = {}) {
  const pageNo = Math.min(ui.pages[key] || 0, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  const slice = rows.slice(pageNo * pageSize, pageNo * pageSize + pageSize);
  const html = `<div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${slice.map((r) => `<tr${onRow ? ` data-row="${esc(r.id)}" style="cursor:pointer"` : ''}>${columns.map((c) => `<td class="${c.num ? 'num' : ''}">${c.render(r)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}" class="muted">Nothing here.</td></tr>`}</tbody></table></div>
    <div class="pager" data-pager="${key}">${rows.length} rows · page ${pageNo + 1} / ${Math.max(1, Math.ceil(rows.length / pageSize))}
      <button class="btn small" data-page="-1"${pageNo === 0 ? ' disabled' : ''}>‹ Prev</button>
      <button class="btn small" data-page="1"${(pageNo + 1) * pageSize >= rows.length ? ' disabled' : ''}>Next ›</button></div>`;
  return { html, wire(root) {
    $$(`[data-pager="${key}"] [data-page]`, root).forEach((b) => { b.onclick = () => { ui.pages[key] = pageNo + Number(b.dataset.page); render(); }; });
    if (onRow) $$('[data-row]', root).forEach((tr) => { tr.onclick = (e) => { if (!e.target.closest('a,button')) onRow(tr.dataset.row); }; });
  } };
}

const scoped = (list) => (companyFilter() ? list.filter((e) => e.companyId === companyFilter()) : list);
const byNewest = (a, b) => (a.id < b.id ? 1 : -1);
const custOptions = () => scoped(S().customers).map((c) => [c.id, `${c.name} (${c.id})`]);

// ---- forms for actions ------------------------------------------------------------------
function newCustomerForm() {
  openForm({
    title: 'New customer',
    fields: [
      { name: 'companyId', label: 'Company', type: 'select', options: S().companies.map((c) => [c.id, c.name]), value: dispatchCompany() },
      { name: 'type', label: 'Type', type: 'select', options: ['residential', 'commercial'] },
      { name: 'name', label: 'Name', full: true },
      { name: 'phone', label: 'Phone' },
      { name: 'email', label: 'Email' },
      { name: 'address', label: 'Street address', full: true },
      { name: 'zone', label: 'Zone', type: 'select', options: C.ZONE_NAMES },
      { name: 'prefersSms', label: 'Prefers SMS', type: 'checkbox' },
    ],
    submitLabel: 'Create customer',
    onSubmit(v) {
      const r = act('createCustomer', v, 'Customer created');
      if (r.ok) { closeModal(); location.hash = `#/customers/${r.result.customer.id}`; }
      return r;
    },
  });
}

function jobForm(customerId) {
  const locs = customerId ? S().locations.filter((l) => l.customerId === customerId) : [];
  openForm({
    title: 'New job',
    fields: [
      customerId ? { name: 'customerId', label: 'Customer', type: 'select', options: [[customerId, get('customers', customerId).name]] } : { name: 'customerId', label: 'Customer ID', placeholder: 'CUS-00001' },
      customerId ? { name: 'locationId', label: 'Location', type: 'select', options: locs.map((l) => [l.id, `${l.address} (${l.zone})`]) } : { name: 'locationId', label: 'Location ID (optional)' },
      { name: 'trade', label: 'Trade', type: 'select', options: C.TRADES.map((t) => [t, C.TRADE_LABELS[t]]) },
      { name: 'priority', label: 'Priority', type: 'select', options: C.PRIORITIES, value: 'normal' },
      { name: 'summary', label: 'Summary (optional)', full: true },
      { name: 'items', type: 'items' },
    ],
    submitLabel: 'Create job',
    onSubmit(v) {
      const r = act('createJob', { ...v, locationId: v.locationId || undefined, summary: v.summary || undefined }, 'Job created');
      if (r.ok) openJob(r.result.job.id);
      return r;
    },
  });
}

function estimateForm(customerId, est) {
  const locs = S().locations.filter((l) => l.customerId === (est?.customerId || customerId));
  openForm({
    title: est ? `Edit estimate ${est.id}` : 'New estimate',
    fields: est ? [
      { name: 'summary', label: 'Summary', full: true, value: est.summary },
      { name: 'items', type: 'items', value: est.items },
    ] : [
      { name: 'customerId', label: 'Customer', type: 'select', options: [[customerId, get('customers', customerId).name]] },
      { name: 'locationId', label: 'Location', type: 'select', options: locs.map((l) => [l.id, `${l.address} (${l.zone})`]) },
      { name: 'trade', label: 'Trade', type: 'select', options: C.TRADES.map((t) => [t, C.TRADE_LABELS[t]]) },
      { name: 'summary', label: 'Summary (optional)' },
      { name: 'items', type: 'items' },
    ],
    submitLabel: est ? 'Save estimate' : 'Create estimate',
    onSubmit(v) {
      const r = est ? act('updateEstimate', { estimateId: est.id, ...v }, 'Estimate updated') : act('createEstimate', { ...v, summary: v.summary || undefined }, 'Estimate created');
      if (r.ok) openEstimate(r.result.estimate.id);
      return r;
    },
  });
}

function notifyForm(customerId, refType, refId) {
  const c = get('customers', customerId);
  openForm({
    title: `Message ${c.name}`,
    fields: [
      { name: 'channel', label: 'Channel', type: 'select', options: [['sms', `SMS ${c.phone}`], ['email', `Email ${c.email}`]], value: c.prefersSms ? 'sms' : 'email' },
      { name: 'message', label: 'Message', type: 'textarea', full: true },
    ],
    submitLabel: 'Send',
    onSubmit(v) {
      const r = act('notifyCustomer', { customerId, ...v, ...(refId ? { refType, refId } : {}) }, 'Message sent');
      if (r.ok) closeModal();
      return r;
    },
  });
}

function scheduleForm(job) {
  const date = job.date || C.addDays(S().meta.today, 1);
  const start = job.startMin ?? 540;
  const techs = S().technicians.filter((t) => t.companyId === job.companyId && t.trades.includes(job.trade) && t.active);
  const suggest = () => {
    const d = $('[name=date]').value;
    const s = $('[name=start]').value;
    const r = ff.query('findAvailableTechs', { jobId: job.id, date: d, start: s });
    $('#suggest').innerHTML = r.ok ? (r.result.length ? `Free (nearest first): ${r.result.map((t) => `<a href="#" data-pick="${t.techId}">${esc(t.name)}</a> ${t.distance} mi`).join(' · ')}` : 'No qualified technician is free at that time.') : esc(r.error.message);
    $$('[data-pick]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); $('[name=techId]').value = a.dataset.pick; }; });
  };
  openForm({
    title: `Schedule ${job.id}`,
    fields: [
      { name: 'date', label: 'Date', type: 'date', value: date },
      { name: 'start', label: 'Start', type: 'time', value: C.fmtTime(start), step: 900 },
      { name: 'techId', label: `Technician (${C.TRADE_LABELS[job.trade]})`, type: 'select', options: techs.map((t) => [t.id, `${t.name} — ${t.zone}`]), value: job.techId || techs[0]?.id, full: true },
      { name: 'notify', label: 'Notify customer', type: 'select', options: [['', 'No notification'], ['sms', 'SMS'], ['email', 'Email']] },
      { type: 'html', html: '<button type="button" class="btn small" id="suggest-btn">Find nearest free technicians</button> <span id="suggest" class="muted tiny"></span>' },
    ],
    submitLabel: 'Schedule',
    onSubmit(v) {
      const r = act('scheduleJob', { jobId: job.id, techId: v.techId, date: v.date, start: v.start, notify: v.notify || undefined }, 'Job scheduled');
      if (r.ok) openJob(job.id);
      return r;
    },
  });
  $('#suggest-btn').onclick = suggest;
}

function paymentForm(inv) {
  openForm({
    title: `Record payment on ${inv.id}`,
    fields: [
      { name: 'amount', label: 'Amount ($)', type: 'number', step: '0.01', value: (C.invoiceBalance(inv) / 100).toFixed(2) },
      { name: 'method', label: 'Method', type: 'select', options: C.PAYMENT_METHODS },
      { name: 'note', label: 'Note (check #, etc.)', full: true },
      { name: 'sendReceipt', label: 'Receipt', type: 'select', options: [['', 'No receipt'], ['email', 'Email'], ['sms', 'SMS']] },
    ],
    submitLabel: 'Record payment',
    onSubmit(v) {
      const r = act('recordPayment', { invoiceId: inv.id, amountCents: Math.round(parseFloat(v.amount) * 100), method: v.method, note: v.note || undefined, sendReceipt: v.sendReceipt || undefined }, 'Payment recorded');
      if (r.ok) openInvoice(inv.id);
      return r;
    },
  });
}

function reasonForm(title, label, onSubmit) {
  openForm({ title, fields: [{ name: 'reason', label, full: true }], submitLabel: 'Confirm', onSubmit });
}

// ---- detail modals ------------------------------------------------------------------
function itemsTable(items, totals) {
  return `<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead><tbody>
    ${items.map((i) => `<tr><td>${i.code ? `<span class="muted tiny">${esc(i.code)}</span> ` : ''}${esc(i.description)}</td><td class="num">${i.qty}</td><td class="num">${money(i.unitPriceCents)}</td><td class="num">${money(i.qty * i.unitPriceCents)}</td></tr>`).join('')}
    ${totals ? `<tr><td colspan="3" class="num muted">Subtotal</td><td class="num">${money(totals.subtotalCents)}</td></tr><tr><td colspan="3" class="num muted">Tax</td><td class="num">${money(totals.taxCents)}</td></tr><tr><td colspan="3" class="num"><strong>Total</strong></td><td class="num"><strong>${money(totals.totalCents)}</strong></td></tr>` : ''}
  </tbody></table>`;
}

function openJob(id) {
  const j = get('jobs', id);
  if (!j) return toast(`job ${id} not found`, true);
  const loc = get('locations', j.locationId);
  const invs = S().invoices.filter((i) => i.jobId === j.id);
  const B = (k, label, cls = '') => `<button class="btn ${cls}" data-a="${k}">${label}</button>`;
  const btns = [];
  if (j.status === 'unscheduled' || j.status === 'scheduled') btns.push(B('schedule', j.status === 'scheduled' ? 'Reschedule' : 'Schedule', 'primary'));
  if (j.status === 'scheduled') btns.push(B('unschedule', 'Unschedule'), B('start', 'Start'));
  if (j.status === 'scheduled' || j.status === 'in_progress') btns.push(B('complete', 'Complete'));
  if (j.status === 'completed' && !invs.some((i) => i.status !== 'void')) btns.push(B('invoice', 'Create invoice', 'primary'));
  if (j.status !== 'completed' && j.status !== 'canceled') btns.push(B('cancel', 'Cancel job', 'danger'));
  btns.push(B('notify', 'Message customer'));
  openModal({
    title: `${j.id} ${pill(j.status)} ${j.priority !== 'normal' ? pill(j.priority) : ''}`,
    reopen: () => openJob(id),
    body: `<dl class="kv">
      <dt>Customer</dt><dd>${custLink(j.customerId)}</dd>
      <dt>Location</dt><dd>${esc(loc.address)}, ${esc(loc.city)} · ${esc(loc.zone)} zone</dd>
      <dt>Trade / type</dt><dd>${tradeTag(j.trade)} ${esc(j.jobType)}</dd>
      <dt>Summary</dt><dd>${esc(j.summary)}</dd>
      <dt>Schedule</dt><dd>${j.date ? `${j.date} ${C.fmtTime(j.startMin)}–${C.fmtTime(j.startMin + j.durationMin)} · ${esc(techName(j.techId))}` : '<span class="muted">unscheduled</span>'} (${j.durationMin} min)</dd>
      <dt>Estimate</dt><dd>${j.estimateId ? `<a href="#" data-est="${j.estimateId}">${j.estimateId}</a>` : '—'}</dd>
      <dt>Invoices</dt><dd>${invs.map((i) => `<a href="#" data-inv="${i.id}">${i.id}</a> ${pill(i.status)}`).join(' ') || '—'}</dd>
      <dt>Created</dt><dd>${j.createdAt}${j.completedAt ? ` · completed ${j.completedAt}` : ''}${j.canceledAt ? ` · canceled ${j.canceledAt} (${esc(j.cancelReason)})` : ''}</dd>
      ${j.notes ? `<dt>Notes</dt><dd>${esc(j.notes)}</dd>` : ''}
    </dl><h3>Line items</h3>${itemsTable(j.items, C.computeTotals(j.items, C.companyOf(S(), j.companyId).taxRate))}`,
    footer: btns.join(''),
    onMount(m) {
      $$('[data-est]', m).forEach((a) => { a.onclick = (e) => { e.preventDefault(); openEstimate(a.dataset.est); }; });
      $$('[data-inv]', m).forEach((a) => { a.onclick = (e) => { e.preventDefault(); openInvoice(a.dataset.inv); }; });
      $$('[data-a]', m).forEach((b) => { b.onclick = () => {
        const k = b.dataset.a;
        if (k === 'schedule') scheduleForm(j);
        if (k === 'unschedule') act('unscheduleJob', { jobId: j.id }, 'Job unscheduled');
        if (k === 'start') act('startJob', { jobId: j.id }, 'Job started');
        if (k === 'complete') act('completeJob', { jobId: j.id }, 'Job completed');
        if (k === 'invoice') { const r = act('createInvoice', { jobId: j.id }, 'Invoice created'); if (r.ok) openInvoice(r.result.invoice.id); }
        if (k === 'cancel') reasonForm(`Cancel ${j.id}`, 'Reason', (v) => { const r = act('cancelJob', { jobId: j.id, reason: v.reason, notify: true }, 'Job canceled; customer notified'); if (r.ok) openJob(j.id); return r; });
        if (k === 'notify') notifyForm(j.customerId, 'job', j.id);
      }; });
    },
  });
}

function openEstimate(id) {
  const e = get('estimates', id);
  const editable = e.status === 'draft' || e.status === 'sent';
  openModal({
    title: `Estimate ${e.id} ${pill(e.status)}`,
    reopen: () => openEstimate(id),
    body: `<dl class="kv"><dt>Customer</dt><dd>${custLink(e.customerId)}</dd><dt>Location</dt><dd>${esc(get('locations', e.locationId).address)}</dd>
      <dt>Trade</dt><dd>${tradeTag(e.trade)}</dd><dt>Summary</dt><dd>${esc(e.summary)}</dd>
      <dt>Dates</dt><dd>created ${e.createdAt}${e.sentAt ? ` · sent ${e.sentAt}` : ''}${e.decidedAt ? ` · decided ${e.decidedAt}` : ''}</dd>
      ${e.declineReason ? `<dt>Decline reason</dt><dd>${esc(e.declineReason)}</dd>` : ''}
      ${e.jobId ? `<dt>Job</dt><dd><a href="#" data-job="${e.jobId}">${e.jobId}</a></dd>` : ''}</dl>
      <h3>Line items</h3>${itemsTable(e.items, e)}`,
    footer: editable ? `<button class="btn" data-a="edit">Edit items</button><button class="btn" data-a="send">${e.status === 'sent' ? 'Re-send' : 'Send'}</button><button class="btn danger" data-a="decline">Decline</button><button class="btn primary" data-a="approve">Approve → job</button>` : '',
    onMount(m) {
      $$('[data-job]', m).forEach((a) => { a.onclick = (ev) => { ev.preventDefault(); openJob(a.dataset.job); }; });
      $$('[data-a]', m).forEach((b) => { b.onclick = () => {
        const k = b.dataset.a;
        if (k === 'edit') estimateForm(null, e);
        if (k === 'send') act('sendEstimate', { estimateId: e.id }, 'Estimate sent');
        if (k === 'decline') reasonForm(`Decline ${e.id}`, 'Reason', (v) => { const r = act('declineEstimate', { estimateId: e.id, reason: v.reason }, 'Estimate declined'); if (r.ok) openEstimate(e.id); return r; });
        if (k === 'approve') { const r = act('approveEstimate', { estimateId: e.id }, 'Approved — job created'); if (r.ok) openJob(r.result.job.id); }
      }; });
    },
  });
}

function openInvoice(id) {
  const i = get('invoices', id);
  const pays = S().payments.filter((p) => p.invoiceId === i.id);
  const btns = [];
  if (i.status === 'draft') btns.push('<button class="btn" data-a="send">Send</button>');
  if (['draft', 'sent', 'partially_paid'].includes(i.status)) btns.push('<button class="btn primary" data-a="pay">Record payment</button>');
  if (i.status !== 'void' && i.amountPaidCents === 0) btns.push('<button class="btn danger" data-a="void">Void</button>');
  openModal({
    title: `Invoice ${i.id} ${pill(i.status)}`,
    reopen: () => openInvoice(id),
    body: `<dl class="kv"><dt>Customer</dt><dd>${custLink(i.customerId)}</dd><dt>Job</dt><dd><a href="#" data-job="${i.jobId}">${i.jobId}</a></dd>
      <dt>Dates</dt><dd>created ${i.createdAt}${i.sentAt ? ` · sent ${i.sentAt}` : ''}${i.dueDate ? ` · due ${i.dueDate}` : ''}${i.voidedAt ? ` · voided ${i.voidedAt} (${esc(i.voidReason)})` : ''}</dd>
      <dt>Paid / balance</dt><dd>${money(i.amountPaidCents)} / <strong>${money(C.invoiceBalance(i))}</strong></dd></dl>
      <h3>Line items</h3>${itemsTable(i.items, i)}
      <h3>Payments</h3>${pays.length ? `<table><tbody>${pays.map((p) => `<tr><td>${p.id}</td><td>${p.date}</td><td>${esc(p.method)}</td><td class="num">${money(p.amountCents)}</td><td>${pill(p.status)}</td><td>${p.status === 'completed' ? `<button class="btn small danger" data-refund="${p.id}">Refund</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No payments.</p>'}`,
    footer: btns.join(''),
    onMount(m) {
      $$('[data-job]', m).forEach((a) => { a.onclick = (ev) => { ev.preventDefault(); openJob(a.dataset.job); }; });
      $$('[data-refund]', m).forEach((b) => { b.onclick = () => act('refundPayment', { paymentId: b.dataset.refund }, 'Payment refunded'); });
      $$('[data-a]', m).forEach((b) => { b.onclick = () => {
        const k = b.dataset.a;
        if (k === 'send') act('sendInvoice', { invoiceId: i.id }, 'Invoice sent');
        if (k === 'pay') paymentForm(i);
        if (k === 'void') reasonForm(`Void ${i.id}`, 'Reason', (v) => { const r = act('voidInvoice', { invoiceId: i.id, reason: v.reason }, 'Invoice voided'); if (r.ok) openInvoice(i.id); return r; });
      }; });
    },
  });
}

// ---- views --------------------------------------------------------------------------
const VIEWS = {};

VIEWS.dashboard = (el) => {
  const st = S();
  const r = ff.query('report', { companyId: companyFilter() }).result;
  const today = st.meta.today;
  const todays = scoped(st.jobs).filter((j) => j.date === today && j.status !== 'canceled').sort((a, b) => a.startMin - b.startMin);
  const notes = scoped(st.notifications).slice(-8).reverse();
  el.innerHTML = `<div class="grid kpis">
      ${kpi("Today's jobs", todays.length, `${todays.filter((j) => j.status === 'in_progress').length} in progress`)}
      ${kpi('Unscheduled queue', r.unscheduledJobs, '<a href="#/dispatch">open dispatch board</a>')}
      ${kpi('Collected (30d)', money(r.revenue.collectedCents), `${r.revenue.payments} payments`)}
      ${kpi('Invoiced (30d)', money(r.revenue.invoicedCents), `avg ticket ${money(r.jobs.avgTicketCents)}`)}
      ${kpi('Open receivables', money(r.receivables.openCents), `${money(r.receivables.aging.d90_plus)} over 90 days`)}
      ${kpi('Estimate close rate', `${Math.round(r.estimates.closeRate * 100)}%`, `${r.estimates.open} open estimates`)}
    </div>
    <div class="grid two">
      <div class="card"><h2>Today · ${today}</h2>${todays.length ? `<table><tbody>${todays.map((j) => `<tr data-job="${j.id}" style="cursor:pointer"><td>${C.fmtTime(j.startMin)}</td><td>${tradeTag(j.trade)}</td><td>${esc(j.summary)}<div class="muted tiny">${esc(get('customers', j.customerId).name)} · ${esc(techName(j.techId))}</div></td><td>${pill(j.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No jobs today.</p>'}</div>
      <div class="card"><h2>Latest notifications</h2>${notes.length ? `<table><tbody>${notes.map((n) => `<tr><td>${pill(n.channel)}</td><td>${custLink(n.customerId)}<div class="tiny muted">${esc(n.message)}</div></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No messages sent in this session yet.</p>'}</div>
    </div>`;
  $$('[data-job]', el).forEach((tr) => { tr.onclick = (e) => { if (!e.target.closest('a')) openJob(tr.dataset.job); }; });
};
const kpi = (label, value, sub = '') => `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

VIEWS.customers = (el, [id]) => {
  if (id) return customerDetail(el, id);
  const f = (ui.filters.customers ||= { q: '', type: '' });
  const res = ff.query('listCustomers', { companyId: companyFilter(), type: f.type || undefined, q: f.q || undefined }).result.items;
  const balances = new Map();
  for (const i of S().invoices) balances.set(i.customerId, (balances.get(i.customerId) || 0) + C.invoiceBalance(i));
  const t = table('customers', res, [
    { label: 'ID', render: (c) => c.id },
    { label: 'Name', render: (c) => `<a href="#/customers/${c.id}">${esc(c.name)}</a>` },
    { label: 'Type', render: (c) => esc(c.type) },
    { label: 'Phone', render: (c) => esc(c.phone) },
    { label: 'Email', render: (c) => esc(c.email) },
    { label: 'Company', render: (c) => c.companyId },
    { label: 'Balance', num: true, render: (c) => money(balances.get(c.id) || 0) },
  ], { onRow: (cid) => { location.hash = `#/customers/${cid}`; } });
  el.innerHTML = `<div class="toolbar"><input id="q" placeholder="Search name, phone, email" value="${esc(f.q)}" size="30">
    <select id="type"><option value="">All types</option><option${f.type === 'residential' ? ' selected' : ''}>residential</option><option${f.type === 'commercial' ? ' selected' : ''}>commercial</option></select>
    <span class="spacer"></span><button class="btn primary" id="new">+ New customer</button></div>${t.html}`;
  t.wire(el);
  $('#q', el).onchange = (e) => { f.q = e.target.value; ui.pages.customers = 0; render(); };
  $('#type', el).onchange = (e) => { f.type = e.target.value; ui.pages.customers = 0; render(); };
  $('#new', el).onclick = newCustomerForm;
};

function customerDetail(el, id) {
  const r = ff.query('getCustomer', { customerId: id });
  if (!r.ok) { el.innerHTML = `<p>${esc(r.error.message)}</p>`; return; }
  const { customer: c, locations, jobs, estimates, invoices, payments, notifications, balanceCents } = r.result;
  $('#page-title').textContent = c.name;
  el.innerHTML = `<div class="toolbar"><a href="#/customers">‹ All customers</a><span class="spacer"></span>
      <button class="btn" id="edit">Edit contact</button><button class="btn" id="loc">+ Location</button><button class="btn" id="msg">Message</button>
      <button class="btn" id="est">+ Estimate</button><button class="btn primary" id="job">+ Job</button></div>
    <div class="grid two">
      <div class="card"><h2>${esc(c.name)} <span class="muted tiny">${c.id}</span></h2><dl class="kv">
        <dt>Type</dt><dd>${esc(c.type)}</dd><dt>Company</dt><dd>${esc(C.companyOf(S(), c.companyId).name)}</dd>
        <dt>Phone</dt><dd>${esc(c.phone)}</dd><dt>Email</dt><dd>${esc(c.email)}</dd>
        <dt>Preferred channel</dt><dd>${c.prefersSms ? 'SMS' : 'Email'}</dd><dt>Customer since</dt><dd>${c.createdAt}</dd>
        <dt>Open balance</dt><dd><strong>${money(balanceCents)}</strong></dd>${c.notes ? `<dt>Notes</dt><dd>${esc(c.notes)}</dd>` : ''}</dl></div>
      <div class="card"><h2>Locations</h2><table><tbody>${locations.map((l) => `<tr><td>${l.id}</td><td>${esc(l.label)}</td><td>${esc(l.address)}, ${esc(l.city)}</td><td>${esc(l.zone)}</td></tr>`).join('')}</tbody></table></div>
    </div>
    <h3>Jobs (${jobs.length})</h3>${miniTable(jobs.slice().sort(byNewest), [['ID', (j) => j.id], ['Date', (j) => j.date ? `${j.date} ${C.fmtTime(j.startMin)}` : '—'], ['Trade', (j) => tradeTag(j.trade)], ['Summary', (j) => esc(j.summary)], ['Tech', (j) => esc(techName(j.techId))], ['Status', (j) => pill(j.status)]], 'job')}
    <h3>Estimates (${estimates.length})</h3>${miniTable(estimates.slice().sort(byNewest), [['ID', (e) => e.id], ['Created', (e) => e.createdAt], ['Summary', (e) => esc(e.summary)], ['Total', (e) => money(e.totalCents)], ['Status', (e) => pill(e.status)]], 'est')}
    <h3>Invoices (${invoices.length})</h3>${miniTable(invoices.slice().sort(byNewest), [['ID', (i) => i.id], ['Created', (i) => i.createdAt], ['Due', (i) => i.dueDate || '—'], ['Total', (i) => money(i.totalCents)], ['Balance', (i) => money(C.invoiceBalance(i))], ['Status', (i) => pill(i.status)]], 'inv')}
    <h3>Payments (${payments.length})</h3>${miniTable(payments.slice().sort(byNewest), [['ID', (p) => p.id], ['Date', (p) => p.date], ['Invoice', (p) => p.invoiceId], ['Method', (p) => p.method], ['Amount', (p) => money(p.amountCents)], ['Status', (p) => pill(p.status)]])}
    <h3>Messages (${notifications.length})</h3>${miniTable(notifications.slice().reverse(), [['ID', (n) => n.id], ['Channel', (n) => n.channel], ['Template', (n) => esc(n.template)], ['Message', (n) => esc(n.message)]])}`;
  $$('[data-open]', el).forEach((tr) => { tr.onclick = () => ({ job: openJob, est: openEstimate, inv: openInvoice })[tr.dataset.kind](tr.dataset.open); });
  $('#job', el).onclick = () => jobForm(c.id);
  $('#est', el).onclick = () => estimateForm(c.id);
  $('#msg', el).onclick = () => notifyForm(c.id);
  $('#loc', el).onclick = () => openForm({
    title: 'Add location', submitLabel: 'Add location',
    fields: [{ name: 'label', label: 'Label', value: 'Additional site' }, { name: 'zone', label: 'Zone', type: 'select', options: C.ZONE_NAMES }, { name: 'address', label: 'Street address', full: true }],
    onSubmit: (v) => { const x = act('addLocation', { customerId: c.id, ...v }, 'Location added'); if (x.ok) closeModal(); return x; },
  });
  $('#edit', el).onclick = () => openForm({
    title: `Edit ${c.name}`, submitLabel: 'Save',
    fields: [{ name: 'name', label: 'Name', value: c.name, full: true }, { name: 'phone', label: 'Phone', value: c.phone }, { name: 'email', label: 'Email', value: c.email }, { name: 'prefersSms', label: 'Prefers SMS', type: 'checkbox', value: c.prefersSms }, { name: 'notes', label: 'Notes', type: 'textarea', value: c.notes, full: true }],
    onSubmit: (v) => { const x = act('updateCustomer', { customerId: c.id, ...v }, 'Customer updated'); if (x.ok) closeModal(); return x; },
  });
}

function miniTable(rows, cols, kind) {
  if (!rows.length) return '<p class="muted">None.</p>';
  return `<div class="table-wrap"><table><thead><tr>${cols.map(([l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, 100).map((r) => `<tr${kind ? ` data-open="${r.id}" data-kind="${kind}" style="cursor:pointer"` : ''}>${cols.map(([, f]) => `<td>${f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

VIEWS.jobs = (el) => {
  const f = (ui.filters.jobs ||= { status: '', trade: '', date: '', q: '' });
  let rows = scoped(S().jobs).filter((j) => (!f.status || j.status === f.status) && (!f.trade || j.trade === f.trade) && (!f.date || j.date === f.date));
  if (f.q) { const q = f.q.toLowerCase(); rows = rows.filter((j) => j.id.toLowerCase().includes(q) || get('customers', j.customerId).name.toLowerCase().includes(q) || j.summary.toLowerCase().includes(q)); }
  rows = rows.slice().sort(byNewest);
  const t = table('jobs', rows, [
    { label: 'ID', render: (j) => j.id },
    { label: 'When', render: (j) => (j.date ? `${j.date} ${C.fmtTime(j.startMin)}` : '<span class="muted">—</span>') },
    { label: 'Trade', render: (j) => tradeTag(j.trade) },
    { label: 'Summary', render: (j) => esc(j.summary) },
    { label: 'Customer', render: (j) => custLink(j.customerId) },
    { label: 'Technician', render: (j) => esc(techName(j.techId)) },
    { label: 'Priority', render: (j) => (j.priority === 'normal' ? '' : pill(j.priority)) },
    { label: 'Status', render: (j) => pill(j.status) },
  ], { onRow: openJob });
  const opt = (list, cur, all) => `<option value="">${all}</option>${list.map((s) => `<option${s === cur ? ' selected' : ''}>${s}</option>`).join('')}`;
  el.innerHTML = `<div class="toolbar"><input id="q" placeholder="Search id, customer, summary" value="${esc(f.q)}">
    <select id="status">${opt(C.JOB_STATUSES, f.status, 'All statuses')}</select><select id="trade">${opt(C.TRADES, f.trade, 'All trades')}</select>
    <input id="date" type="date" value="${esc(f.date)}"><span class="spacer"></span><button class="btn primary" id="new">+ New job</button></div>${t.html}`;
  t.wire(el);
  for (const k of ['q', 'status', 'trade', 'date']) $(`#${k}`, el).onchange = (e) => { f[k] = e.target.value; ui.pages.jobs = 0; render(); };
  $('#new', el).onclick = () => jobForm(null);
};

VIEWS.dispatch = (el) => {
  const st = S();
  const companyId = dispatchCompany();
  const date = ui.dispatchDate;
  const techs = st.technicians.filter((t) => t.companyId === companyId && (!ui.dispatchTrade || t.trades.includes(ui.dispatchTrade)));
  const dayJobs = st.jobs.filter((j) => j.companyId === companyId && j.date === date && j.status !== 'canceled' && j.status !== 'unscheduled');
  const queue = st.jobs.filter((j) => j.companyId === companyId && j.status === 'unscheduled' && (!ui.dispatchTrade || j.trade === ui.dispatchTrade))
    .sort((a, b) => C.PRIORITIES.indexOf(b.priority) - C.PRIORITIES.indexOf(a.priority) || (a.id < b.id ? -1 : 1));
  const pct = (m) => `${((m - DAY_START) / SPAN) * 100}%`;
  const hours = [];
  for (let h = 8; h < 18; h++) hours.push(`<span style="left:${pct(h * 60)}">${String(h).padStart(2, '0')}:00</span>`);
  const nowLine = date === st.meta.today ? `<div class="tl-now" style="left:${pct(st.meta.nowMin)}"></div>` : '';
  const rows = techs.map((t) => {
    const blocks = dayJobs.filter((j) => j.techId === t.id).map((j) => {
      const cu = get('customers', j.customerId);
      const draggable = j.status === 'scheduled';
      return `<div class="jb ${j.trade} ${j.status} ${j.priority}" data-job="${j.id}" draggable="${draggable}" data-dur="${j.durationMin}" style="left:${pct(j.startMin)};width:calc(${(j.durationMin / SPAN) * 100}% - 2px)" title="${esc(`${j.id} · ${j.summary} · ${cu.name} · ${C.fmtTime(j.startMin)}-${C.fmtTime(j.startMin + j.durationMin)} · ${j.status}`)}">
        <strong>${C.fmtTime(j.startMin)}</strong> ${esc(cu.name)}<br>${esc(j.summary)}</div>`;
    }).join('');
    const off = `<div class="tl-off" style="left:0;width:${pct(t.shiftStart)}"></div><div class="tl-off" style="left:${pct(t.shiftEnd)};right:0"></div>`;
    return `<div class="tl-row${t.active ? '' : ' inactive'}"><div class="tl-tech"><span class="dot" style="background:${t.color}"></span><strong>${esc(t.name)}</strong>
      <div class="tiny muted">${t.id} · ${t.trades.map((x) => C.TRADE_LABELS[x]).join('/')} · ${t.zone}${t.active ? '' : ' · INACTIVE'}</div></div>
      <div class="tl-lane" data-tech="${t.id}">${off}${nowLine}${blocks}</div></div>`;
  }).join('');
  el.innerHTML = `<div class="toolbar">
      <button class="btn" id="prev">‹</button><input type="date" id="date" value="${date}"><button class="btn" id="next">›</button>
      <button class="btn" id="today">Today</button><strong>${C.DOW_NAMES[C.dayOfWeek(date)]}</strong>
      <select id="trade"><option value="">All trades</option>${C.TRADES.map((t) => `<option value="${t}"${ui.dispatchTrade === t ? ' selected' : ''}>${C.TRADE_LABELS[t]}</option>`).join('')}</select>
      <span class="muted tiny">${C.companyOf(st, companyId).name} · drag jobs between technicians/times, drop on the queue to unschedule</span></div>
    <div class="board">
      <div class="timeline"><div class="tl-head"><div style="padding:6px 10px">Technician</div><div class="tl-hours">${hours.join('')}</div></div>${rows}</div>
      <div class="card queue" id="queue"><h2>Unscheduled (${queue.length})</h2>${queue.map((j) => `<div class="qitem ${j.trade}" draggable="true" data-job="${j.id}" data-dur="${j.durationMin}">
        <strong>${j.id}</strong> ${j.priority !== 'normal' ? pill(j.priority) : ''}<br>${esc(j.summary)}<div class="muted tiny">${esc(get('customers', j.customerId).name)} · ${get('locations', j.locationId).zone} · ${j.durationMin} min</div></div>`).join('') || '<p class="muted">Queue is empty.</p>'}</div>
    </div>`;
  const setDate = (d) => { ui.dispatchDate = d; render(); };
  $('#prev', el).onclick = () => setDate(C.addDays(date, -1));
  $('#next', el).onclick = () => setDate(C.addDays(date, 1));
  $('#today', el).onclick = () => setDate(st.meta.today);
  $('#date', el).onchange = (e) => C.isDate(e.target.value) && setDate(e.target.value);
  $('#trade', el).onchange = (e) => { ui.dispatchTrade = e.target.value; render(); };
  let drag = null;
  $$('[data-job]', el).forEach((b) => {
    b.addEventListener('click', () => openJob(b.dataset.job));
    b.addEventListener('dragstart', (e) => {
      const rect = b.getBoundingClientRect();
      const lane = b.closest('.tl-lane');
      const grabMin = lane ? ((e.clientX - rect.left) / lane.getBoundingClientRect().width) * SPAN : 0;
      drag = { jobId: b.dataset.job, grabMin };
      e.dataTransfer.setData('text/plain', b.dataset.job);
      e.dataTransfer.effectAllowed = 'move';
    });
  });
  $$('.tl-lane', el).forEach((lane) => {
    lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('drop-hover'); });
    lane.addEventListener('dragleave', () => lane.classList.remove('drop-hover'));
    lane.addEventListener('drop', (e) => {
      e.preventDefault();
      lane.classList.remove('drop-hover');
      if (!drag) return;
      const rect = lane.getBoundingClientRect();
      const raw = DAY_START + ((e.clientX - rect.left) / rect.width) * SPAN - drag.grabMin;
      const start = Math.max(0, Math.round(raw / 30) * 30);
      act('scheduleJob', { jobId: drag.jobId, techId: lane.dataset.tech, date, start }, `${drag.jobId} → ${techName(lane.dataset.tech)} ${C.fmtTime(start)}`);
      drag = null;
    });
  });
  const q = $('#queue', el);
  q.addEventListener('dragover', (e) => { e.preventDefault(); q.classList.add('drop-hover'); });
  q.addEventListener('dragleave', () => q.classList.remove('drop-hover'));
  q.addEventListener('drop', (e) => {
    e.preventDefault();
    q.classList.remove('drop-hover');
    if (drag && get('jobs', drag.jobId).status === 'scheduled') act('unscheduleJob', { jobId: drag.jobId }, `${drag.jobId} returned to queue`);
    drag = null;
  });
};

VIEWS.estimates = (el) => {
  const f = (ui.filters.estimates ||= { status: '' });
  const rows = scoped(S().estimates).filter((e) => !f.status || e.status === f.status).slice().sort(byNewest);
  const t = table('estimates', rows, [
    { label: 'ID', render: (e) => e.id },
    { label: 'Created', render: (e) => e.createdAt },
    { label: 'Customer', render: (e) => custLink(e.customerId) },
    { label: 'Trade', render: (e) => tradeTag(e.trade) },
    { label: 'Summary', render: (e) => esc(e.summary) },
    { label: 'Total', num: true, render: (e) => money(e.totalCents) },
    { label: 'Status', render: (e) => pill(e.status) },
    { label: 'Job', render: (e) => e.jobId || '' },
  ], { onRow: openEstimate });
  el.innerHTML = `<div class="toolbar"><select id="status"><option value="">All statuses</option>${C.ESTIMATE_STATUSES.map((s) => `<option${s === f.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
    <span class="muted tiny">Create estimates from a customer page.</span></div>${t.html}`;
  t.wire(el);
  $('#status', el).onchange = (e) => { f.status = e.target.value; ui.pages.estimates = 0; render(); };
};

VIEWS.invoices = (el) => {
  const f = (ui.filters.invoices ||= { status: '', overdue: false });
  const today = S().meta.today;
  const rows = scoped(S().invoices).filter((i) => (!f.status || i.status === f.status) && (!f.overdue || (C.invoiceBalance(i) > 0 && i.dueDate && i.dueDate < today))).slice().sort(byNewest);
  const t = table('invoices', rows, [
    { label: 'ID', render: (i) => i.id },
    { label: 'Created', render: (i) => i.createdAt },
    { label: 'Due', render: (i) => (i.dueDate ? (C.invoiceBalance(i) > 0 && i.dueDate < today ? `<strong style="color:var(--bad)">${i.dueDate}</strong>` : i.dueDate) : '—') },
    { label: 'Customer', render: (i) => custLink(i.customerId) },
    { label: 'Job', render: (i) => i.jobId },
    { label: 'Total', num: true, render: (i) => money(i.totalCents) },
    { label: 'Balance', num: true, render: (i) => money(C.invoiceBalance(i)) },
    { label: 'Status', render: (i) => pill(i.status) },
  ], { onRow: openInvoice });
  el.innerHTML = `<div class="toolbar"><select id="status"><option value="">All statuses</option>${C.INVOICE_STATUSES.map((s) => `<option${s === f.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
    <label><input type="checkbox" id="overdue"${f.overdue ? ' checked' : ''}> Overdue only</label></div>${t.html}`;
  t.wire(el);
  $('#status', el).onchange = (e) => { f.status = e.target.value; ui.pages.invoices = 0; render(); };
  $('#overdue', el).onchange = (e) => { f.overdue = e.target.checked; ui.pages.invoices = 0; render(); };
};

VIEWS.payments = (el) => {
  const rows = scoped(S().payments).slice().sort(byNewest);
  const t = table('payments', rows, [
    { label: 'ID', render: (p) => p.id },
    { label: 'Date', render: (p) => p.date },
    { label: 'Customer', render: (p) => custLink(p.customerId) },
    { label: 'Invoice', render: (p) => `<a href="#" data-inv="${p.invoiceId}">${p.invoiceId}</a>` },
    { label: 'Method', render: (p) => esc(p.method) },
    { label: 'Amount', num: true, render: (p) => money(p.amountCents) },
    { label: 'Status', render: (p) => pill(p.status) },
    { label: '', render: (p) => (p.status === 'completed' ? `<button class="btn small danger" data-refund="${p.id}">Refund</button>` : '') },
  ]);
  el.innerHTML = t.html;
  t.wire(el);
  $$('[data-inv]', el).forEach((a) => { a.onclick = (e) => { e.preventDefault(); openInvoice(a.dataset.inv); }; });
  $$('[data-refund]', el).forEach((b) => { b.onclick = () => { if (confirm(`Refund ${b.dataset.refund}?`)) act('refundPayment', { paymentId: b.dataset.refund }, 'Payment refunded'); }; });
};

VIEWS.reports = (el) => {
  const f = (ui.filters.reports ||= { from: C.addDays(S().meta.today, -29), to: S().meta.today });
  const r = ff.query('report', { companyId: companyFilter(), from: f.from, to: f.to }).result;
  const months = [];
  for (let k = 4; k >= 0; k--) {
    const d = C.addDays(S().meta.today, -30 * k);
    const ym = d.slice(0, 7);
    if (!months.includes(ym)) months.push(ym);
  }
  const monthly = months.map((m) => ({ m, v: scoped(S().payments).filter((p) => p.status === 'completed' && p.date.startsWith(m)).reduce((a, p) => a + p.amountCents, 0) }));
  const maxV = Math.max(1, ...monthly.map((x) => x.v));
  const ag = r.receivables.aging;
  const agMax = Math.max(1, ...Object.values(ag));
  el.innerHTML = `<div class="toolbar"><label>From <input type="date" id="from" value="${f.from}"></label><label>To <input type="date" id="to" value="${f.to}"></label></div>
    <div class="grid kpis">
      ${kpi('Jobs in range', r.jobs.total, `${r.jobs.completed} completed`)}
      ${kpi('Invoiced', money(r.revenue.invoicedCents))}
      ${kpi('Collected', money(r.revenue.collectedCents), `${r.revenue.payments} payments`)}
      ${kpi('Avg ticket', money(r.jobs.avgTicketCents))}
      ${kpi('Estimates', r.estimates.created, `close rate ${Math.round(r.estimates.closeRate * 100)}%`)}
      ${kpi('Open A/R', money(r.receivables.openCents))}
    </div>
    <div class="grid two">
      <div class="card"><h2>Collections by month</h2><div class="chart-bars">${monthly.map((x) => `<div class="col"><span>${money(x.v).replace(/\.\d\d$/, '')}</span><div style="height:${(x.v / maxV) * 100}%"></div><span>${x.m}</span></div>`).join('')}</div></div>
      <div class="card"><h2>Receivables aging</h2><table><tbody>${Object.entries({ Current: ag.current, '1–30 days': ag.d1_30, '31–60 days': ag.d31_60, '61–90 days': ag.d61_90, '90+ days': ag.d90_plus }).map(([k, v]) => `<tr><td style="width:110px">${k}</td><td><div class="bar"><div style="width:${(v / agMax) * 100}%"></div></div></td><td class="num" style="width:110px">${money(v)}</td></tr>`).join('')}</tbody></table></div>
      <div class="card"><h2>By trade</h2><table><thead><tr><th>Trade</th><th class="num">Jobs</th><th class="num">Completed</th><th class="num">Invoiced</th></tr></thead><tbody>${Object.entries(r.jobs.byTrade).map(([k, v]) => `<tr><td>${tradeTag(k)}</td><td class="num">${v.jobs}</td><td class="num">${v.completed}</td><td class="num">${money(v.invoicedCents)}</td></tr>`).join('')}</tbody></table>
        <h3>Jobs by status</h3><table><tbody>${Object.entries(r.jobs.byStatus).map(([k, v]) => `<tr><td>${pill(k)}</td><td class="num">${v}</td></tr>`).join('')}</tbody></table></div>
      <div class="card"><h2>Technician utilization</h2><table><thead><tr><th>Technician</th><th class="num">Jobs</th><th>Utilization</th><th class="num">Revenue</th></tr></thead><tbody>${r.technicians.slice().sort((a, b) => b.utilization - a.utilization).map((t) => `<tr><td>${esc(t.name)}<div class="tiny muted">${t.trades.map((x) => C.TRADE_LABELS[x]).join('/')}</div></td><td class="num">${t.jobs}</td><td style="min-width:100px"><div class="bar"><div style="width:${Math.min(100, t.utilization * 100)}%"></div></div><span class="tiny muted">${Math.round(t.utilization * 100)}%</span></td><td class="num">${money(t.revenueCents)}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
  $('#from', el).onchange = (e) => { f.from = e.target.value; render(); };
  $('#to', el).onchange = (e) => { f.to = e.target.value; render(); };
};

VIEWS.notifications = (el) => {
  const rows = scoped(S().notifications).slice().reverse();
  const t = table('notifications', rows, [
    { label: 'ID', render: (n) => n.id },
    { label: 'Sent', render: (n) => n.sentAt },
    { label: 'Channel', render: (n) => pill(n.channel) },
    { label: 'To', render: (n) => `${custLink(n.customerId)}<div class="tiny muted">${esc(n.to)}</div>` },
    { label: 'Template', render: (n) => esc(n.template) },
    { label: 'Ref', render: (n) => (n.refId ? `${n.refType} ${n.refId}` : '') },
    { label: 'Message', render: (n) => esc(n.message) },
  ]);
  el.innerHTML = `<p class="muted">Simulated outbound SMS/email. Nothing is actually delivered.</p>${t.html}`;
  t.wire(el);
};

VIEWS.technicians = (el) => {
  const rows = scoped(S().technicians);
  const today = S().meta.today;
  el.innerHTML = miniTable(rows, [
    ['ID', (t) => t.id], ['Name', (t) => `<span class="tl-tech"><span class="dot" style="background:${t.color}"></span></span>${esc(t.name)}`],
    ['Company', (t) => t.companyId], ['Trades', (t) => t.trades.map(tradeTag).join(' ')], ['Zone', (t) => t.zone],
    ['Shift', (t) => `${C.fmtTime(t.shiftStart)}–${C.fmtTime(t.shiftEnd)}`],
    ['Today', (t) => `${S().jobs.filter((j) => j.techId === t.id && j.date === today && j.status !== 'canceled').length} jobs`],
    ['Status', (t) => `${t.active ? pill('active') : pill('inactive')} <button class="btn small" data-toggle="${t.id}">${t.active ? 'Deactivate' : 'Activate'}</button>`],
  ]);
  $$('[data-toggle]', el).forEach((b) => { b.onclick = () => { const t = get('technicians', b.dataset.toggle); act('setTechnicianActive', { techId: t.id, active: !t.active }, `${t.name} ${t.active ? 'deactivated' : 'activated'}`); }; });
};

VIEWS.tasks = async (el) => {
  el.innerHTML = '<p class="muted">Loading tasks…</p>';
  const tasks = await ff.listTasks();
  el.innerHTML = `<p class="muted">Example agent tasks. <strong>Start</strong> resets the world to the task's seed; perform the work in the UI or via <code>window.fieldforge</code>; <strong>Check</strong> runs the automatic checker on the current state.</p>
    <div class="table-wrap"><table><thead><tr><th>Task</th><th>Seed</th><th>Prompt</th><th></th></tr></thead><tbody>
    ${tasks.map((t) => `<tr${ff.activeTaskId === t.id ? ' style="background:#fff4ea"' : ''}><td><strong>${t.id}</strong><div class="tiny muted">${esc(t.title)}</div></td><td>${t.seed}</td><td>${esc(t.prompt)}<div class="tiny" id="res-${t.id}"></div></td>
      <td><button class="btn small" data-start="${t.id}">Start</button> <button class="btn small primary" data-check="${t.id}">Check</button></td></tr>`).join('')}</tbody></table></div>`;
  $$('[data-start]', el).forEach((b) => { b.onclick = async () => { await ff.startTask(b.dataset.start); toast(`Started ${b.dataset.start} (seed reset)`); render(); }; });
  $$('[data-check]', el).forEach((b) => { b.onclick = async () => {
    const r = await ff.checkTask(b.dataset.check);
    $(`#res-${b.dataset.check}`, el).innerHTML = r.pass ? '<span class="pill completed">PASS</span>' : `<span class="pill canceled">FAIL</span> ${esc(r.reasons.join('; '))}`;
  }; });
};

VIEWS.api = (el) => {
  el.innerHTML = `<div class="card"><p>Everything in this UI is available programmatically through <code>window.fieldforge</code> (open the browser console). Results are <code>{ok, result}</code> or <code>{ok:false, error:{code, message}}</code>. Money is in integer cents; times are minutes since midnight or "HH:MM".</p>
    <pre class="code">fieldforge.findAvailableTechs({ jobId: 'JOB-004604', date: '2026-03-10', start: '15:00' })
fieldforge.scheduleJob({ jobId: 'JOB-004604', techId: 'TEC-024', date: '2026-03-10', start: '15:00', notify: 'sms' })
fieldforge.recordPayment({ invoiceId: 'INV-02144', amountCents: 10618, method: 'card' })
fieldforge.reset(42)
await fieldforge.startTask('t01-reassign-nearest-hvac'); await fieldforge.checkTask()</pre>
    <pre class="code">${esc(ff.help())}</pre></div>`;
};

// ---- shell -----------------------------------------------------------------------------
const TITLES = { dashboard: 'Dashboard', dispatch: 'Dispatch board', jobs: 'Jobs', customers: 'Customers', estimates: 'Estimates', invoices: 'Invoices', payments: 'Payments', reports: 'Reports', notifications: 'Notification log', technicians: 'Technicians', tasks: 'Agent tasks', api: 'Browser API' };

function renderChrome() {
  const st = S();
  $('#clock').textContent = `Sim time: ${st.meta.today} ${C.fmtTime(st.meta.nowMin)}`;
  $('#seed-input').value = st.meta.seed;
  $('#session-info').textContent = `${st.actionLog.length} actions this session${ff.activeTaskId ? ` · task ${ff.activeTaskId}` : ''}`;
  const sel = $('#company-select');
  sel.innerHTML = `<option value="all">All companies</option>${st.companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}`;
  sel.value = ui.company;
}

function render() {
  const [route = 'dashboard', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const view = VIEWS[route] ? route : 'dashboard';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === view));
  $('#page-title').textContent = TITLES[view];
  renderChrome();
  const el = $('#view');
  const scroll = window.scrollY;
  VIEWS[view](el, rest);
  window.scrollTo(0, scroll);
}

$('#company-select').onchange = (e) => {
  ui.company = e.target.value;
  localStorage.setItem('fieldforge:ui:company', ui.company);
  ui.pages = {};
  render();
};
$('#reset-btn').onclick = () => {
  const seed = $('#seed-input').value.trim() || String(S().meta.seed);
  if (!confirm(`Reset all data to seed ${seed}? Your session's changes will be discarded.`)) return;
  ff.reset(seed);
  closeModal();
  ui.dispatchDate = S().meta.today;
  toast(`World reset to seed ${S().meta.seed}`);
};
ff.subscribe(() => render());
window.addEventListener('hashchange', () => { closeModal(); render(); });
render();
