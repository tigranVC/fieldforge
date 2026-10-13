// State-mutating actions. Every action validates fully before mutating, so a
// failed action leaves state untouched. The same registry backs the SPA, the
// window.fieldforge API and the REST server.
import { TRADES, PRIORITIES, PAYMENT_METHODS, CHANNELS, TRADE_LABELS } from './catalog.js';
import { isDate, parseTime, fmtTime, fmtMoney, addDays } from './util.js';
import {
  ActionError, nextId, byId, mustGet, companyOf, computeTotals, normalizeItems, itemsDuration, primaryKind,
  zoneJitter, slotProblem, isPastSlot, recomputeInvoice, invoiceBalance, nowStamp,
} from './model.js';

// ---- small validators -------------------------------------------------------
const str = (v, name, { required = false, max = 500 } = {}) => {
  if (v == null || v === '') {
    if (required) throw new ActionError('INVALID_PARAMS', `${name} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new ActionError('INVALID_PARAMS', `${name} must be a string`);
  const t = v.trim();
  if (required && !t) throw new ActionError('INVALID_PARAMS', `${name} is required`);
  if (t.length > max) throw new ActionError('INVALID_PARAMS', `${name} is too long`);
  return t;
};
const oneOf = (v, list, name, dflt) => {
  if (v == null || v === '') {
    if (dflt !== undefined) return dflt;
    throw new ActionError('INVALID_PARAMS', `${name} is required (one of ${list.join(', ')})`);
  }
  if (!list.includes(v)) throw new ActionError('INVALID_PARAMS', `${name} must be one of ${list.join(', ')}`);
  return v;
};
const channelOf = (v, customer) => {
  if (v === true || v === 'preferred') return customer.prefersSms ? 'sms' : 'email';
  return oneOf(v, CHANNELS, 'channel');
};

function zoneFor(state, companyId, zone) {
  const company = companyOf(state, companyId);
  if (!company.zones.includes(zone)) throw new ActionError('INVALID_PARAMS', `zone must be one of ${company.zones.join(', ')}`);
  return zone;
}

function addNotification(state, { customer, channel, template, message, refType = null, refId = null }) {
  const n = {
    id: nextId(state, 'notification'),
    companyId: customer.companyId,
    customerId: customer.id,
    channel,
    to: channel === 'sms' ? customer.phone : customer.email,
    template,
    message,
    refType,
    refId,
    sentAt: nowStamp(state),
  };
  state.notifications.push(n);
  return n;
}

function techFirst(state, techId) {
  const t = byId(state, 'technicians', techId);
  return t ? t.name.split(' ')[0] : 'our technician';
}

function resolveSlot(state, job, p) {
  const tech = mustGet(state, 'technicians', p.techId, 'technician');
  if (!isDate(p.date)) throw new ActionError('INVALID_PARAMS', 'date must be YYYY-MM-DD');
  const start = parseTime(p.start);
  if (!Number.isInteger(start) || start < 0 || start >= 1440) throw new ActionError('INVALID_PARAMS', 'start must be minutes since midnight or "HH:MM"');
  if (isPastSlot(state, p.date, start)) throw new ActionError('PAST_SLOT', `cannot schedule in the past (now is ${state.meta.today} ${fmtTime(state.meta.nowMin)})`);
  const durationMin = job.durationMin;
  const problem = slotProblem(state, tech, job, p.date, start, durationMin);
  if (problem) throw problem;
  return { tech, date: p.date, start };
}

function scheduleMessage(state, job) {
  return `Your ${TRADE_LABELS[job.trade]} appointment (${job.id}) is scheduled for ${job.date} at ${fmtTime(job.startMin)} with ${techFirst(state, job.techId)}.`;
}

function resolveItemsAndTrade(p) {
  const trade = oneOf(p.trade, TRADES, 'trade');
  let rawItems = p.items;
  if ((!rawItems || rawItems.length === 0) && p.serviceCode) rawItems = [{ code: p.serviceCode, qty: 1 }];
  const items = normalizeItems(rawItems, trade);
  return { trade, items };
}

// ---- action registry ---------------------------------------------------------
// params: [name, type, required, description]
export const ACTIONS = {
  createCustomer: {
    description: 'Create a customer with a primary service location.',
    params: [
      ['companyId', 'string', true, 'Company the customer belongs to (CO-1..CO-3)'],
      ['name', 'string', true, 'Customer / business name'],
      ['type', 'residential|commercial', false, 'Default residential'],
      ['phone', 'string', false, 'Phone number'],
      ['email', 'string', false, 'Email address'],
      ['prefersSms', 'boolean', false, 'Preferred notification channel is SMS'],
      ['address', 'string', true, 'Street address of the primary location'],
      ['zone', 'string', true, 'Service zone: Central, North, South, East or West'],
      ['city', 'string', false, 'Defaults to the company city'],
      ['notes', 'string', false, 'Free-form notes'],
    ],
    run(state, p) {
      const company = companyOf(state, p.companyId);
      if (!company) throw new ActionError('NOT_FOUND', `company ${p.companyId} not found`);
      const name = str(p.name, 'name', { required: true });
      const type = oneOf(p.type, ['residential', 'commercial'], 'type', 'residential');
      const address = str(p.address, 'address', { required: true });
      const zone = zoneFor(state, company.id, p.zone);
      const customer = {
        id: nextId(state, 'customer'), companyId: company.id, name, type,
        phone: str(p.phone, 'phone') || '', email: str(p.email, 'email') || '',
        prefersSms: Boolean(p.prefersSms), notes: str(p.notes, 'notes', { max: 2000 }) || '', createdAt: state.meta.today,
      };
      state.customers.push(customer);
      const location = {
        id: nextId(state, 'location'), customerId: customer.id, companyId: company.id,
        label: type === 'commercial' ? 'Main site' : 'Home', address, city: str(p.city, 'city') || company.city, zone,
        ...zoneJitter(address, zone),
      };
      state.locations.push(location);
      return { customer, location };
    },
  },

  updateCustomer: {
    description: 'Update customer contact details.',
    params: [
      ['customerId', 'string', true, ''],
      ['name', 'string', false, ''],
      ['phone', 'string', false, ''],
      ['email', 'string', false, ''],
      ['prefersSms', 'boolean', false, ''],
      ['notes', 'string', false, ''],
    ],
    run(state, p) {
      const c = mustGet(state, 'customers', p.customerId, 'customer');
      const patch = {};
      if (p.name !== undefined) patch.name = str(p.name, 'name', { required: true });
      if (p.phone !== undefined) patch.phone = str(p.phone, 'phone') || '';
      if (p.email !== undefined) patch.email = str(p.email, 'email') || '';
      if (p.notes !== undefined) patch.notes = str(p.notes, 'notes', { max: 2000 }) || '';
      if (p.prefersSms !== undefined) {
        if (typeof p.prefersSms !== 'boolean') throw new ActionError('INVALID_PARAMS', 'prefersSms must be boolean');
        patch.prefersSms = p.prefersSms;
      }
      if (Object.keys(patch).length === 0) throw new ActionError('INVALID_PARAMS', 'nothing to update');
      Object.assign(c, patch);
      return { customer: c };
    },
  },

  addLocation: {
    description: 'Add a service location to an existing customer.',
    params: [
      ['customerId', 'string', true, ''],
      ['address', 'string', true, ''],
      ['zone', 'string', true, 'Central, North, South, East or West'],
      ['city', 'string', false, ''],
      ['label', 'string', false, 'e.g. "Warehouse"'],
    ],
    run(state, p) {
      const c = mustGet(state, 'customers', p.customerId, 'customer');
      const address = str(p.address, 'address', { required: true });
      const zone = zoneFor(state, c.companyId, p.zone);
      const location = {
        id: nextId(state, 'location'), customerId: c.id, companyId: c.companyId,
        label: str(p.label, 'label') || 'Additional site', address,
        city: str(p.city, 'city') || companyOf(state, c.companyId).city, zone, ...zoneJitter(address, zone),
      };
      state.locations.push(location);
      return { location };
    },
  },

  createJob: {
    description: 'Create a job (work order). Optionally schedule it immediately by passing techId+date+start.',
    params: [
      ['customerId', 'string', true, ''],
      ['locationId', 'string', false, "Defaults to the customer's first location"],
      ['trade', 'hvac|plumbing|electrical', true, ''],
      ['items', '[{code,qty}|{description,qty,unitPriceCents}]', false, 'Line items (or use serviceCode)'],
      ['serviceCode', 'string', false, 'Shortcut for a single price-book item'],
      ['summary', 'string', false, 'Defaults to first item description'],
      ['priority', 'low|normal|high|emergency', false, 'Default normal'],
      ['jobType', 'string', false, 'service|repair|maintenance|install|inspection; defaults from price book'],
      ['durationMin', 'integer', false, 'Defaults to price-book labor time'],
      ['techId', 'string', false, 'Schedule immediately with this technician'],
      ['date', 'YYYY-MM-DD', false, ''],
      ['start', 'minutes|"HH:MM"', false, ''],
      ['notify', 'sms|email|true', false, 'Send a scheduling confirmation'],
      ['notes', 'string', false, ''],
    ],
    run(state, p) {
      const customer = mustGet(state, 'customers', p.customerId, 'customer');
      let location;
      if (p.locationId) {
        location = mustGet(state, 'locations', p.locationId, 'location');
        if (location.customerId !== customer.id) throw new ActionError('INVALID_PARAMS', `location ${location.id} does not belong to ${customer.id}`);
      } else {
        location = state.locations.find((l) => l.customerId === customer.id);
      }
      const { trade, items } = resolveItemsAndTrade(p);
      const priority = oneOf(p.priority, PRIORITIES, 'priority', 'normal');
      let durationMin = itemsDuration(items);
      if (p.durationMin != null) {
        durationMin = Number(p.durationMin);
        if (!Number.isInteger(durationMin) || durationMin < 15 || durationMin > 600) throw new ActionError('INVALID_PARAMS', 'durationMin must be an integer 15..600');
      }
      const job = {
        id: null, companyId: customer.companyId, customerId: customer.id, locationId: location.id, trade,
        jobType: str(p.jobType, 'jobType') || (priority === 'emergency' ? 'emergency' : primaryKind(items)),
        priority, summary: str(p.summary, 'summary') || items[0].description, items, durationMin,
        status: 'unscheduled', techId: null, date: null, startMin: null, estimateId: null,
        createdAt: state.meta.today, completedAt: null, canceledAt: null, cancelReason: null,
        notes: str(p.notes, 'notes', { max: 2000 }) || '',
      };
      const wantsSchedule = p.techId != null || p.date != null || p.start != null;
      let slot = null;
      if (wantsSchedule) slot = resolveSlot(state, job, p);
      const channel = p.notify ? channelOf(p.notify, customer) : null;
      job.id = nextId(state, 'job');
      if (slot) Object.assign(job, { techId: slot.tech.id, date: slot.date, startMin: slot.start, status: 'scheduled' });
      state.jobs.push(job);
      let notification = null;
      if (channel) {
        notification = addNotification(state, {
          customer, channel, template: slot ? 'job_scheduled' : 'job_created', refType: 'job', refId: job.id,
          message: slot ? scheduleMessage(state, job) : `We received your ${TRADE_LABELS[trade]} request (${job.id}). We'll be in touch to schedule.`,
        });
      }
      return { job, notification };
    },
  },

  updateJob: {
    description: 'Edit job summary, priority, duration or notes.',
    params: [
      ['jobId', 'string', true, ''],
      ['summary', 'string', false, ''],
      ['priority', 'low|normal|high|emergency', false, ''],
      ['durationMin', 'integer', false, 'Checked against the schedule if the job is booked'],
      ['notes', 'string', false, ''],
    ],
    run(state, p) {
      const job = mustGet(state, 'jobs', p.jobId, 'job');
      if (job.status === 'completed' || job.status === 'canceled') throw new ActionError('INVALID_STATE', `job ${job.id} is ${job.status}`);
      const patch = {};
      if (p.summary !== undefined) patch.summary = str(p.summary, 'summary', { required: true });
      if (p.priority !== undefined) patch.priority = oneOf(p.priority, PRIORITIES, 'priority');
      if (p.notes !== undefined) patch.notes = str(p.notes, 'notes', { max: 2000 }) || '';
      if (p.durationMin !== undefined) {
        const d = Number(p.durationMin);
        if (!Number.isInteger(d) || d < 15 || d > 600) throw new ActionError('INVALID_PARAMS', 'durationMin must be an integer 15..600');
        if (job.techId && job.date) {
          const tech = byId(state, 'technicians', job.techId);
          const problem = slotProblem(state, { ...tech, active: true }, job, job.date, job.startMin, d);
          if (problem) throw problem;
        }
        patch.durationMin = d;
      }
      if (Object.keys(patch).length === 0) throw new ActionError('INVALID_PARAMS', 'nothing to update');
      Object.assign(job, patch);
      return { job };
    },
  },

  scheduleJob: {
    description: 'Assign or reschedule a job to a technician, date and start time (dispatch board drag & drop).',
    params: [
      ['jobId', 'string', true, ''],
      ['techId', 'string', true, 'Must be active, same company, qualified for the trade'],
      ['date', 'YYYY-MM-DD', true, 'Not in the past'],
      ['start', 'minutes|"HH:MM"', true, 'Job must fit inside the tech shift and not overlap other jobs'],
      ['notify', 'sms|email|true', false, 'Send the customer a scheduling notification'],
    ],
    run(state, p) {
      const job = mustGet(state, 'jobs', p.jobId, 'job');
      if (job.status !== 'unscheduled' && job.status !== 'scheduled') throw new ActionError('INVALID_STATE', `job ${job.id} is ${job.status}; only unscheduled/scheduled jobs can be (re)scheduled`);
      const slot = resolveSlot(state, job, p);
      const customer = byId(state, 'customers', job.customerId);
      const channel = p.notify ? channelOf(p.notify, customer) : null;
      const wasScheduled = job.status === 'scheduled';
      Object.assign(job, { techId: slot.tech.id, date: slot.date, startMin: slot.start, status: 'scheduled' });
      let notification = null;
      if (channel) {
        notification = addNotification(state, {
          customer, channel, template: wasScheduled ? 'job_rescheduled' : 'job_scheduled', refType: 'job', refId: job.id,
          message: (wasScheduled ? 'Update: ' : '') + scheduleMessage(state, job),
        });
      }
      return { job, notification };
    },
  },

  unscheduleJob: {
    description: 'Remove tech/date from a scheduled job and return it to the unscheduled queue.',
    params: [['jobId', 'string', true, '']],
    run(state, p) {
      const job = mustGet(state, 'jobs', p.jobId, 'job');
      if (job.status !== 'scheduled') throw new ActionError('INVALID_STATE', `job ${job.id} is ${job.status}; only scheduled jobs can be unscheduled`);
      Object.assign(job, { techId: null, date: null, startMin: null, status: 'unscheduled' });
      return { job };
    },
  },

  startJob: {
    description: 'Technician arrived: mark a scheduled job in progress.',
    params: [['jobId', 'string', true, '']],
    run(state, p) {
      const job = mustGet(state, 'jobs', p.jobId, 'job');
      if (job.status !== 'scheduled') throw new ActionError('INVALID_STATE', `job ${job.id} is ${job.status}`);
      if (job.date > state.meta.today) throw new ActionError('INVALID_STATE', `job ${job.id} is scheduled for a future date`);
      job.status = 'in_progress';
      return { job };
    },
  },

  completeJob: {
    description: 'Mark a scheduled or in-progress job completed.',
    params: [['jobId', 'string', true, ''], ['notes', 'string', false, 'Completion notes']],
    run(state, p) {
      const job = mustGet(state, 'jobs', p.jobId, 'job');
      if (job.status !== 'in_progress' && job.status !== 'scheduled') throw new ActionError('INVALID_STATE', `job ${job.id} is ${job.status}`);
      if (job.date > state.meta.today) throw new ActionError('INVALID_STATE', `job ${job.id} is scheduled for a future date`);
      const notes = str(p.notes, 'notes', { max: 2000 });
      Object.assign(job, { status: 'completed', completedAt: state.meta.today });
      if (notes) job.notes = job.notes ? `${job.notes}\n${notes}` : notes;
      return { job };
    },
  },

  cancelJob: {
    description: 'Cancel a job that is not yet completed.',
    params: [
      ['jobId', 'string', true, ''],
      ['reason', 'string', false, ''],
      ['notify', 'sms|email|true', false, 'Send the customer a cancellation notice'],
    ],
    run(state, p) {
      const job = mustGet(state, 'jobs', p.jobId, 'job');
      if (job.status === 'completed' || job.status === 'canceled') throw new ActionError('INVALID_STATE', `job ${job.id} is ${job.status}`);
      const customer = byId(state, 'customers', job.customerId);
      const channel = p.notify ? channelOf(p.notify, customer) : null;
      Object.assign(job, { status: 'canceled', canceledAt: state.meta.today, cancelReason: str(p.reason, 'reason') || 'unspecified' });
      let notification = null;
      if (channel) {
        notification = addNotification(state, {
          customer, channel, template: 'job_canceled', refType: 'job', refId: job.id,
          message: `Your ${TRADE_LABELS[job.trade]} appointment (${job.id}) has been canceled.`,
        });
      }
      return { job, notification };
    },
  },

  createEstimate: {
    description: 'Create a draft estimate (quote) for a customer.',
    params: [
      ['customerId', 'string', true, ''],
      ['locationId', 'string', false, "Defaults to the customer's first location"],
      ['trade', 'hvac|plumbing|electrical', true, ''],
      ['items', '[{code,qty}|{description,qty,unitPriceCents}]', true, 'Price-book codes get standard prices'],
      ['summary', 'string', false, ''],
    ],
    run(state, p) {
      const customer = mustGet(state, 'customers', p.customerId, 'customer');
      let location;
      if (p.locationId) {
        location = mustGet(state, 'locations', p.locationId, 'location');
        if (location.customerId !== customer.id) throw new ActionError('INVALID_PARAMS', `location ${location.id} does not belong to ${customer.id}`);
      } else location = state.locations.find((l) => l.customerId === customer.id);
      const trade = oneOf(p.trade, TRADES, 'trade');
      const items = normalizeItems(p.items, trade);
      const est = {
        id: nextId(state, 'estimate'), companyId: customer.companyId, customerId: customer.id, locationId: location.id,
        trade, summary: str(p.summary, 'summary') || items[0].description, items,
        ...computeTotals(items, companyOf(state, customer.companyId).taxRate),
        status: 'draft', createdAt: state.meta.today, sentAt: null, decidedAt: null, declineReason: null, jobId: null,
      };
      state.estimates.push(est);
      return { estimate: est };
    },
  },

  updateEstimate: {
    description: 'Replace line items and/or summary on a draft or sent estimate.',
    params: [
      ['estimateId', 'string', true, ''],
      ['items', 'array', false, 'Full replacement list of line items'],
      ['summary', 'string', false, ''],
    ],
    run(state, p) {
      const est = mustGet(state, 'estimates', p.estimateId, 'estimate');
      if (est.status !== 'draft' && est.status !== 'sent') throw new ActionError('INVALID_STATE', `estimate ${est.id} is ${est.status}`);
      const patch = {};
      if (p.items !== undefined) {
        patch.items = normalizeItems(p.items, est.trade);
        Object.assign(patch, computeTotals(patch.items, companyOf(state, est.companyId).taxRate));
      }
      if (p.summary !== undefined) patch.summary = str(p.summary, 'summary', { required: true });
      if (Object.keys(patch).length === 0) throw new ActionError('INVALID_PARAMS', 'nothing to update');
      Object.assign(est, patch);
      return { estimate: est };
    },
  },

  sendEstimate: {
    description: 'Send (or re-send) an estimate to the customer.',
    params: [['estimateId', 'string', true, ''], ['channel', 'sms|email', false, 'Default email']],
    run(state, p) {
      const est = mustGet(state, 'estimates', p.estimateId, 'estimate');
      if (est.status !== 'draft' && est.status !== 'sent') throw new ActionError('INVALID_STATE', `estimate ${est.id} is ${est.status}`);
      const customer = byId(state, 'customers', est.customerId);
      const channel = oneOf(p.channel, CHANNELS, 'channel', 'email');
      est.status = 'sent';
      est.sentAt = state.meta.today;
      const notification = addNotification(state, {
        customer, channel, template: 'estimate_sent', refType: 'estimate', refId: est.id,
        message: `Your estimate ${est.id} for "${est.summary}" totals ${fmtMoney(est.totalCents)}.`,
      });
      return { estimate: est, notification };
    },
  },

  approveEstimate: {
    description: 'Customer approved the estimate: creates an unscheduled job with the estimate items.',
    params: [['estimateId', 'string', true, '']],
    run(state, p) {
      const est = mustGet(state, 'estimates', p.estimateId, 'estimate');
      if (est.status !== 'draft' && est.status !== 'sent') throw new ActionError('INVALID_STATE', `estimate ${est.id} is ${est.status}`);
      const job = {
        id: nextId(state, 'job'), companyId: est.companyId, customerId: est.customerId, locationId: est.locationId,
        trade: est.trade, jobType: primaryKind(est.items), priority: 'normal', summary: est.summary,
        items: est.items.map((i) => ({ ...i })), durationMin: itemsDuration(est.items), status: 'unscheduled',
        techId: null, date: null, startMin: null, estimateId: est.id, createdAt: state.meta.today,
        completedAt: null, canceledAt: null, cancelReason: null, notes: '',
      };
      state.jobs.push(job);
      Object.assign(est, { status: 'approved', decidedAt: state.meta.today, jobId: job.id });
      return { estimate: est, job };
    },
  },

  declineEstimate: {
    description: 'Customer declined the estimate.',
    params: [['estimateId', 'string', true, ''], ['reason', 'string', false, '']],
    run(state, p) {
      const est = mustGet(state, 'estimates', p.estimateId, 'estimate');
      if (est.status !== 'draft' && est.status !== 'sent') throw new ActionError('INVALID_STATE', `estimate ${est.id} is ${est.status}`);
      Object.assign(est, { status: 'declined', decidedAt: state.meta.today, declineReason: str(p.reason, 'reason') || 'unspecified' });
      return { estimate: est };
    },
  },

  createInvoice: {
    description: 'Create a draft invoice for a completed job (defaults to the job line items).',
    params: [['jobId', 'string', true, ''], ['items', 'array', false, 'Override line items']],
    run(state, p) {
      const job = mustGet(state, 'jobs', p.jobId, 'job');
      if (job.status !== 'completed') throw new ActionError('INVALID_STATE', `job ${job.id} is ${job.status}; only completed jobs can be invoiced`);
      const existing = state.invoices.find((i) => i.jobId === job.id && i.status !== 'void');
      if (existing) throw new ActionError('DUPLICATE', `job ${job.id} already has invoice ${existing.id}`);
      const items = p.items ? normalizeItems(p.items, job.trade) : job.items.map((i) => ({ ...i }));
      const inv = {
        id: nextId(state, 'invoice'), companyId: job.companyId, customerId: job.customerId, jobId: job.id, items,
        ...computeTotals(items, companyOf(state, job.companyId).taxRate), amountPaidCents: 0, status: 'draft',
        createdAt: state.meta.today, sentAt: null, dueDate: null, voidedAt: null, voidReason: null,
      };
      state.invoices.push(inv);
      return { invoice: inv };
    },
  },

  sendInvoice: {
    description: 'Send a draft invoice (sets due date: net 15 residential, net 30 commercial).',
    params: [['invoiceId', 'string', true, ''], ['channel', 'sms|email', false, 'Default email']],
    run(state, p) {
      const inv = mustGet(state, 'invoices', p.invoiceId, 'invoice');
      if (inv.status !== 'draft') throw new ActionError('INVALID_STATE', `invoice ${inv.id} is ${inv.status}; only drafts can be sent`);
      const customer = byId(state, 'customers', inv.customerId);
      const channel = oneOf(p.channel, CHANNELS, 'channel', 'email');
      inv.sentAt = state.meta.today;
      inv.dueDate = addDays(state.meta.today, customer.type === 'commercial' ? 30 : 15);
      recomputeInvoice(state, inv);
      const notification = addNotification(state, {
        customer, channel, template: 'invoice_sent', refType: 'invoice', refId: inv.id,
        message: `Invoice ${inv.id} for ${fmtMoney(inv.totalCents)} is due ${inv.dueDate}.`,
      });
      return { invoice: inv, notification };
    },
  },

  voidInvoice: {
    description: 'Void an invoice that has no completed payments (refund payments first).',
    params: [['invoiceId', 'string', true, ''], ['reason', 'string', false, '']],
    run(state, p) {
      const inv = mustGet(state, 'invoices', p.invoiceId, 'invoice');
      if (inv.status === 'void') throw new ActionError('INVALID_STATE', `invoice ${inv.id} is already void`);
      if (inv.amountPaidCents > 0) throw new ActionError('HAS_PAYMENTS', `invoice ${inv.id} has ${fmtMoney(inv.amountPaidCents)} in payments; refund them first`);
      Object.assign(inv, { status: 'void', voidedAt: state.meta.today, voidReason: str(p.reason, 'reason') || 'unspecified' });
      return { invoice: inv };
    },
  },

  recordPayment: {
    description: 'Record a customer payment against an invoice.',
    params: [
      ['invoiceId', 'string', true, ''],
      ['amountCents', 'integer', true, 'Positive, not more than the open balance'],
      ['method', 'card|check|cash|ach', true, ''],
      ['note', 'string', false, 'e.g. check number'],
      ['sendReceipt', 'sms|email', false, 'Send a receipt notification'],
    ],
    run(state, p) {
      const inv = mustGet(state, 'invoices', p.invoiceId, 'invoice');
      if (inv.status === 'void' || inv.status === 'paid') throw new ActionError('INVALID_STATE', `invoice ${inv.id} is ${inv.status}`);
      const amount = Number(p.amountCents);
      if (!Number.isInteger(amount) || amount <= 0) throw new ActionError('INVALID_PARAMS', 'amountCents must be a positive integer');
      const balance = invoiceBalance(inv);
      if (amount > balance) throw new ActionError('OVERPAYMENT', `amount ${fmtMoney(amount)} exceeds balance ${fmtMoney(balance)}`);
      const method = oneOf(p.method, PAYMENT_METHODS, 'method');
      const customer = byId(state, 'customers', inv.customerId);
      const channel = p.sendReceipt ? channelOf(p.sendReceipt, customer) : null;
      const payment = {
        id: nextId(state, 'payment'), companyId: inv.companyId, customerId: inv.customerId, invoiceId: inv.id,
        amountCents: amount, method, date: state.meta.today, status: 'completed', refundedAt: null, note: str(p.note, 'note') || '',
      };
      state.payments.push(payment);
      recomputeInvoice(state, inv);
      let notification = null;
      if (channel) {
        notification = addNotification(state, {
          customer, channel, template: 'payment_receipt', refType: 'payment', refId: payment.id,
          message: `Thank you! We received ${fmtMoney(amount)} toward invoice ${inv.id}.`,
        });
      }
      return { payment, invoice: inv, notification };
    },
  },

  refundPayment: {
    description: 'Refund a completed payment; the invoice balance reopens.',
    params: [['paymentId', 'string', true, ''], ['reason', 'string', false, '']],
    run(state, p) {
      const pay = mustGet(state, 'payments', p.paymentId, 'payment');
      if (pay.status !== 'completed') throw new ActionError('INVALID_STATE', `payment ${pay.id} is ${pay.status}`);
      const reason = str(p.reason, 'reason');
      pay.status = 'refunded';
      pay.refundedAt = state.meta.today;
      if (reason) pay.note = pay.note ? `${pay.note}; refund: ${reason}` : `refund: ${reason}`;
      const inv = byId(state, 'invoices', pay.invoiceId);
      recomputeInvoice(state, inv);
      return { payment: pay, invoice: inv };
    },
  },

  notifyCustomer: {
    description: 'Send an ad-hoc SMS or email to a customer (logged in the notification log).',
    params: [
      ['customerId', 'string', true, ''],
      ['channel', 'sms|email', true, ''],
      ['message', 'string', true, ''],
      ['refType', 'job|estimate|invoice|payment', false, 'What the message is about'],
      ['refId', 'string', false, 'Id of the referenced entity'],
      ['template', 'string', false, 'Default "custom"'],
    ],
    run(state, p) {
      const customer = mustGet(state, 'customers', p.customerId, 'customer');
      const channel = oneOf(p.channel, CHANNELS, 'channel');
      const message = str(p.message, 'message', { required: true, max: 1000 });
      let refType = null;
      let refId = null;
      if (p.refType != null || p.refId != null) {
        refType = oneOf(p.refType, ['job', 'estimate', 'invoice', 'payment'], 'refType');
        const ref = mustGet(state, `${refType}s`, p.refId, refType);
        if (ref.customerId !== customer.id) throw new ActionError('INVALID_PARAMS', `${refType} ${ref.id} does not belong to ${customer.id}`);
        refId = ref.id;
      }
      const notification = addNotification(state, { customer, channel, template: str(p.template, 'template') || 'custom', message, refType, refId });
      return { notification };
    },
  },

  setTechnicianActive: {
    description: 'Activate or deactivate a technician (inactive techs cannot receive new assignments).',
    params: [['techId', 'string', true, ''], ['active', 'boolean', true, '']],
    run(state, p) {
      const tech = mustGet(state, 'technicians', p.techId, 'technician');
      if (typeof p.active !== 'boolean') throw new ActionError('INVALID_PARAMS', 'active must be boolean');
      tech.active = p.active;
      return { technician: tech };
    },
  },
};

export const ACTION_NAMES = Object.keys(ACTIONS);
