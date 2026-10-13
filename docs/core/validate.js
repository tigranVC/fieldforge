// Global invariants. Returns a list of human-readable problems ([] == valid).
import { computeTotals, byId, occupies } from './model.js';

export function validateState(state) {
  const problems = [];
  const slots = new Map();
  for (const j of state.jobs) {
    if (j.status === 'unscheduled') {
      if (j.techId || j.date || j.startMin != null) problems.push(`${j.id}: unscheduled job still has a slot`);
      continue;
    }
    if (j.status === 'scheduled' || j.status === 'in_progress') {
      if (!j.techId || !j.date || j.startMin == null) { problems.push(`${j.id}: ${j.status} job missing tech/date/start`); continue; }
      const t = byId(state, 'technicians', j.techId);
      if (!t) { problems.push(`${j.id}: unknown technician ${j.techId}`); continue; }
      if (t.companyId !== j.companyId) problems.push(`${j.id}: technician from another company`);
      if (!t.trades.includes(j.trade)) problems.push(`${j.id}: technician ${t.id} not qualified for ${j.trade}`);
      if (j.startMin < t.shiftStart || j.startMin + j.durationMin > t.shiftEnd) problems.push(`${j.id}: outside shift of ${t.id}`);
    }
    if (occupies(j)) {
      const k = `${j.techId}|${j.date}`;
      if (!slots.has(k)) slots.set(k, []);
      slots.get(k).push(j);
    }
  }
  for (const list of slots.values()) {
    list.sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < list.length; i++) {
      if (list[i].startMin < list[i - 1].startMin + list[i - 1].durationMin) problems.push(`${list[i].id} overlaps ${list[i - 1].id} for ${list[i].techId} on ${list[i].date}`);
    }
  }
  const paidBy = new Map();
  for (const p of state.payments) if (p.status === 'completed') paidBy.set(p.invoiceId, (paidBy.get(p.invoiceId) || 0) + p.amountCents);
  for (const inv of state.invoices) {
    const company = state.companies.find((c) => c.id === inv.companyId);
    const t = computeTotals(inv.items, company.taxRate);
    if (t.totalCents !== inv.totalCents || t.subtotalCents !== inv.subtotalCents) problems.push(`${inv.id}: totals do not match items`);
    const paid = paidBy.get(inv.id) || 0;
    if (paid !== inv.amountPaidCents) problems.push(`${inv.id}: amountPaid ${inv.amountPaidCents} != payments ${paid}`);
    if (paid > inv.totalCents) problems.push(`${inv.id}: overpaid`);
    if (inv.status === 'paid' && paid < inv.totalCents) problems.push(`${inv.id}: marked paid with balance`);
    if (inv.status === 'void' && paid > 0) problems.push(`${inv.id}: void with payments`);
  }
  for (const e of state.estimates) {
    if (e.status === 'approved' && !byId(state, 'jobs', e.jobId)) problems.push(`${e.id}: approved without job`);
  }
  return problems;
}
