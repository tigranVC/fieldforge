# FieldForge

A **clean-room, deterministic simulator of a field-service management (FSM) SaaS** for
HVAC, plumbing and electrical contractors — built to be an **RL environment and eval
harness for software agents**.

* Seeded world: 3 companies, 40 technicians, 1,000 customers, ~5,000 jobs, estimates, invoices, payments. Same seed ⇒ byte-identical data.
* One shared core library (`core/`, plain ES modules, zero dependencies) used by both the
  browser SPA and the Node server, so UI, browser API and REST API behave identically.
* Static SPA (`docs/`, GitHub-Pages-ready) with dispatch board, customers, jobs, estimates,
  invoices, payments, reports and a notification log; state persists in `localStorage`.
* `window.fieldforge` browser API and an Express REST API exposing the same actions.
* 30 example agent tasks with automatic state checkers and a verifying runner.

> Clean-room notice: FieldForge is written from general public knowledge of FSM workflows.
> It contains no code, assets, branding, UI or names from any commercial FSM product.
> All people, companies and addresses are fictional.

See **[SPEC.md](SPEC.md)** for workflows, business rules and the data model.

---

## Why: agent RL / evals

Typical back-office agent work — "tech is out sick, re-route their day", "customer approved
the quote, book it", "collect payment", "void that invoice" — needs an environment that is:

| Need | How FieldForge provides it |
|---|---|
| **Reproducible episodes** | `reset(seed)` regenerates the exact same world; actions have no randomness or wall-clock reads; `seed + action log` ⇒ state. |
| **Realistic constraints** | trades, companies, shifts, overlaps, past slots, invoice/payment state machines — violations return typed errors (`CONFLICT`, `TRADE_MISMATCH`, `HAS_PAYMENTS`, …). |
| **Multiple surfaces** | the same actions through a GUI (computer-use agents), `window.fieldforge` (browser agents) and REST (tool-calling agents). |
| **Automatic reward** | each task has a checker `check(finalState, initialState, params) → reasons[]`; pass = no reasons. Checkers also run global invariants (no double-booking, consistent invoices). |
| **Verified tasks** | `npm run tasks:verify` proves every task's checker **fails on the untouched world** and **passes after a reference solution**. |

Typical episode loop:

```text
POST /api/tasks/:id/start        -> world reset to task.seed, returns prompt
agent calls GET/POST /api/...    -> observations & actions
POST /api/tasks/:id/check        -> { pass, reasons[] }  (reward = pass ? 1 : 0)
```

---

## Quick start

```bash
npm install
npm test                 # determinism, actions, server, all 30 task checkers
npm run tasks:verify     # task runner: untouched=fail, reference=pass for every task
npm start                # REST API on http://localhost:3030 (flags: --port, --seed)
npm run serve:docs       # SPA on http://localhost:8080
```

Requires Node ≥ 18 (uses built-in `fetch` and `node:test`).

### GitHub Pages
The SPA is plain static files in `docs/` (no build step at runtime). In repository settings choose
*Pages → Deploy from branch → `/docs`*. `docs/core/` and `docs/tasks/` are copies of `core/` and
the task definitions; after editing those run `npm run build` (a test fails if they drift).

### Using the SPA
* **Company** selector (top right) scopes lists; the dispatch board shows one company.
* **Dispatch board**: technicians × 07:00–18:00. Drag a job (or a queue card) onto a technician's
  lane to assign/reschedule (snaps to 30 min); drop on the queue to unschedule. Hatched areas
  are outside the technician's shift; the red line is "now". Click a job for details and actions.
* **Reset to seed** (sidebar) discards the session and regenerates the world for the given seed.
* **Agent tasks** page: start a task (resets to its seed), do the work, press *Check*.
* Persistence: `localStorage['fieldforge:v1'] = {seed, actions[]}`; on load the action log is replayed.

---

## Conventions

* Money: integer **cents** (`amountCents`, `unitPriceCents`, `totalCents`).
* Dates: `YYYY-MM-DD`. Times: **minutes after midnight** (`540` = 09:00); inputs also accept `"09:00"`.
* Simulated now: `2026-03-09` 10:00 (`state.meta.today`, `state.meta.nowMin`).
* Every action/query returns `{ ok: true, result }` or `{ ok: false, error: { code, message } }`.
  A failed action never changes state. Only successful actions are appended to `actionLog`.
* Error codes: `INVALID_PARAMS`, `NOT_FOUND`, `INVALID_STATE`, `CONFLICT`, `TRADE_MISMATCH`,
  `WRONG_COMPANY`, `OUTSIDE_SHIFT`, `PAST_SLOT`, `TECH_INACTIVE`, `DUPLICATE`, `HAS_PAYMENTS`,
  `OVERPAYMENT`, `UNKNOWN_ACTION`, `UNKNOWN_QUERY`.

## API reference

### Actions (mutations)
Bold = required. Available as `fieldforge.<name>(params)`, `fieldforge.dispatch(name, params)`,
`POST /api/actions/<name>` (JSON body) and the REST aliases below.

| Action | Params | Description |
|---|---|---|
| `createCustomer` | **companyId**, **name**, type, phone, email, prefersSms, **address**, **zone**, city, notes | Create a customer with a primary service location. |
| `updateCustomer` | **customerId**, name, phone, email, prefersSms, notes | Update customer contact details. |
| `addLocation` | **customerId**, **address**, **zone**, city, label | Add a service location to an existing customer. |
| `createJob` | **customerId**, locationId, **trade**, items, serviceCode, summary, priority, jobType, durationMin, techId, date, start, notify, notes | Create a job (work order). Optionally schedule it immediately by passing techId+date+start. |
| `updateJob` | **jobId**, summary, priority, durationMin, notes | Edit job summary, priority, duration or notes. |
| `scheduleJob` | **jobId**, **techId**, **date**, **start**, notify | Assign or reschedule a job to a technician, date and start time (dispatch board drag & drop). |
| `unscheduleJob` | **jobId** | Remove tech/date from a scheduled job and return it to the unscheduled queue. |
| `startJob` | **jobId** | Technician arrived: mark a scheduled job in progress. |
| `completeJob` | **jobId**, notes | Mark a scheduled or in-progress job completed. |
| `cancelJob` | **jobId**, reason, notify | Cancel a job that is not yet completed. |
| `createEstimate` | **customerId**, locationId, **trade**, **items**, summary | Create a draft estimate (quote) for a customer. |
| `updateEstimate` | **estimateId**, items, summary | Replace line items and/or summary on a draft or sent estimate. |
| `sendEstimate` | **estimateId**, channel | Send (or re-send) an estimate to the customer. |
| `approveEstimate` | **estimateId** | Customer approved the estimate: creates an unscheduled job with the estimate items. |
| `declineEstimate` | **estimateId**, reason | Customer declined the estimate. |
| `createInvoice` | **jobId**, items | Create a draft invoice for a completed job (defaults to the job line items). |
| `sendInvoice` | **invoiceId**, channel | Send a draft invoice (sets due date: net 15 residential, net 30 commercial). |
| `voidInvoice` | **invoiceId**, reason | Void an invoice that has no completed payments (refund payments first). |
| `recordPayment` | **invoiceId**, **amountCents**, **method**, note, sendReceipt | Record a customer payment against an invoice. |
| `refundPayment` | **paymentId**, reason | Refund a completed payment; the invoice balance reopens. |
| `notifyCustomer` | **customerId**, **channel**, **message**, refType, refId, template | Send an ad-hoc SMS or email to a customer (logged in the notification log). |
| `setTechnicianActive` | **techId**, **active** | Activate or deactivate a technician (inactive techs cannot receive new assignments). |

### Queries (read-only)
Available as `fieldforge.<name>(params)`, `fieldforge.query(name, params)`, `POST /api/queries/<name>` and the GET routes below.
List queries accept `offset`/`limit` and return `{ total, offset, items }`.

| Query | Params | Description |
|---|---|---|
| `listCustomers` | companyId, type, q, offset, limit | List customers (filters: companyId, type, q = name/phone/email substring). |
| `getCustomer` | **customerId** | Customer with locations, jobs, estimates, invoices, payments, notifications and balance. |
| `listLocations` | customerId, companyId, zone | List locations (filters: customerId, companyId, zone). |
| `listTechnicians` | companyId, trade, zone, active | List technicians (filters: companyId, trade, zone, active). |
| `listJobs` | companyId, customerId, techId, status, trade, priority, date, from, to, offset, limit | List jobs (filters: companyId, customerId, locationId, techId, status, trade, priority, date, from, to). |
| `getJob` | **jobId** | Job with customer, location, technician, estimate and invoices. |
| `listEstimates` | companyId, customerId, status, trade | List estimates (filters: companyId, customerId, status, trade). |
| `listInvoices` | companyId, customerId, jobId, status, overdue | List invoices (filters: companyId, customerId, jobId, status, overdue=true). |
| `listPayments` | companyId, customerId, invoiceId, method, status | List payments (filters: companyId, customerId, invoiceId, method, status). |
| `listNotifications` | companyId, customerId, channel, refType, refId | Notification log (filters: companyId, customerId, channel, refType, refId). |
| `findAvailableTechs` | jobId, companyId, trade, locationId, durationMin, **date**, **start** | Technicians free for a slot, nearest first. Pass jobId (uses its trade/company/location/duration) or companyId+trade(+locationId, durationMin). |
| `techSchedule` | **techId**, date | A technician's booked jobs (optionally for one date). |
| `freeSlots` | **techId**, **date**, durationMin, step | Start times (step minutes, default 30) at which a tech can take a job of durationMin on date. |
| `priceBook` | trade | Price-book services (filter: trade). |
| `report` | companyId, from, to | KPI report: jobs, revenue, receivables aging, estimate close rate, tech utilization. |

### REST endpoints (`server/`)

| Method & path | Maps to |
|---|---|
| `POST /reset`, `POST /api/reset` | body `{ "seed": 42 }` (optional) — regenerate world |
| `GET /api/health` | seed / today |
| `GET /api/state` | full state; `?include=jobs,technicians` to select collections |
| `GET /api/state/summary` | meta + collection counts + active task |
| `GET /api/state/validate` | invariant check `{ ok, problems[] }` |
| `GET /api/action-log` | successful actions this episode |
| `GET /api/notifications` | notification log (`customerId, channel, refType, refId` filters) |
| `GET /api/actions`, `GET /api/queries` | machine-readable catalogue (for tool definitions) |
| `POST /api/actions/:type`, `POST /api/queries/:name` | generic dispatch |
| `GET /api/customers` · `GET /api/customers/:id` · `POST /api/customers` · `PATCH /api/customers/:id` | listCustomers · getCustomer · createCustomer · updateCustomer |
| `POST /api/customers/:id/locations` · `POST /api/customers/:id/notify` | addLocation · notifyCustomer |
| `GET /api/locations[/:id]` | listLocations / entity |
| `GET /api/technicians[/:id]` · `GET /api/technicians/:id/schedule?date=` · `GET /api/technicians/:id/free-slots?date=&durationMin=` · `POST /api/technicians/:id/active` | listTechnicians · techSchedule · freeSlots · setTechnicianActive |
| `GET /api/jobs` · `GET /api/jobs/:id` · `POST /api/jobs` · `PATCH /api/jobs/:id` | listJobs · getJob · createJob · updateJob |
| `POST /api/jobs/:id/{schedule,unschedule,start,complete,cancel}` | scheduleJob · unscheduleJob · startJob · completeJob · cancelJob |
| `GET /api/availability?jobId=&date=&start=` | findAvailableTechs |
| `GET /api/estimates[/:id]` · `POST /api/estimates` · `PATCH /api/estimates/:id` · `POST /api/estimates/:id/{send,approve,decline}` | estimate workflow |
| `GET /api/invoices[/:id]` · `POST /api/invoices` · `POST /api/invoices/:id/{send,void,payments}` | invoice workflow (`payments` = recordPayment) |
| `GET /api/payments[/:id]` · `POST /api/payments/:id/refund` | listPayments · refundPayment |
| `GET /api/price-book` · `GET /api/reports/summary?companyId=&from=&to=` | priceBook · report |
| `GET /api/tasks` · `GET /api/tasks/:id` | task list (checker params hidden) |
| `POST /api/tasks/:id/start` · `POST /api/tasks/:id/check` | reset to task seed · run checker → `{ pass, reasons }` |

HTTP status: 200 ok, 404 `NOT_FOUND`/unknown action, 422 any other rule violation, 400 malformed JSON.

Example (default seed 42):

```bash
curl -s localhost:3030/api/availability?jobId=JOB-004604\&date=2026-03-10\&start=15:00
curl -s -XPOST localhost:3030/api/jobs/JOB-004604/schedule -H 'content-type: application/json' \
     -d '{"techId":"TEC-024","date":"2026-03-10","start":"15:00","notify":"sms"}'
```

### Browser API (`window.fieldforge`)

```js
fieldforge.help()                                   // prints every action/query signature
fieldforge.state                                    // live state object (read-only by convention)
fieldforge.reset(42)                                // pristine world for seed 42
fieldforge.findAvailableTechs({ jobId, date: '2026-03-10', start: '15:00' })
fieldforge.scheduleJob({ jobId, techId, date: '2026-03-10', start: 900, notify: 'sms' })
fieldforge.notifications()  fieldforge.actionLog()  fieldforge.validate()
await fieldforge.listTasks(); await fieldforge.startTask('t08-void-invoice'); await fieldforge.checkTask()
fieldforge.subscribe(evt => ...)                    // UI re-renders on every action
```

### Node library

```js
import { createEngine, generateState, replay, validateState } from './core/index.js';
const env = createEngine(42);
env.dispatch('recordPayment', { invoiceId: 'INV-02144', amountCents: 10618, method: 'card' });
env.query('report', { companyId: 'CO-1' });
```

---

## Tasks

`tasks/tasks.json` holds 30 tasks. Format:

```json
{
  "id": "t01-reassign-nearest-hvac",
  "kind": "reassign_nearest",
  "title": "Reassign a job to the nearest free qualified technician and notify by SMS",
  "seed": 101,
  "prompt": "Technician Dana Xiong (TEC-039) can no longer make job JOB-004604 (...). Reassign the job to the nearest available HVAC technician other than Dana Xiong ... Then notify the customer of the change by SMS.",
  "params": { "jobId": "JOB-004604", "fromTechId": "TEC-039" }
}
```

* `prompt` is what the agent sees; `seed` is the world to reset to; `params` are for the checker only
  (the REST task endpoints hide them).
* The checker for a task is `KINDS[task.kind].check(finalState, initialState, params)` in
  `tasks/kinds.js`; use `checkTask(task, state)` from `tasks/index.js`. Checkers compute expectations
  from the pristine seeded state (e.g. which technician is nearest) and accept any equally-good answer
  (ties in distance, any qualified tech where the prompt says "any").
* Each kind also has `candidates` (deterministic entity selection), `prompt` and a reference `solve`
  that only uses public actions/queries.

| Kinds (count) | |
|---|---|
| reassign_nearest (3), approve_and_schedule (2), emergency_dispatch, earliest_slot (2), tech_out_day, swap_jobs, move_next_day, deactivate_tech | dispatch & scheduling |
| create_estimate (2), discount_estimate, decline_estimate | estimates |
| complete_and_invoice (2), void_invoice (2), collect_full_payment (2), partial_payment, refund_payment, pay_all_open, overdue_reminders | billing & collections |
| new_customer_job, add_location_job, update_phone, cancel_and_notify | customers & jobs |

Scripts:

```bash
npm run tasks:verify            # node tasks/run.js [id-prefix ...]
npm run tasks:generate          # rebuild tasks.json from tasks/specs.js (deterministic)
```

To add a task: add a kind to `tasks/kinds.js` (or reuse one), add a spec in `tasks/specs.js`,
run `npm run tasks:generate && npm run build && npm test`.

---

## Repository layout

```
core/      shared simulation library (browser + Node)
docs/      static SPA (GitHub Pages root); docs/core + docs/tasks are synced copies
server/    Express REST API (app.js = createApp, index.js = CLI)
tasks/     kinds.js, specs.js, tasks.json, generate.js, run.js, index.js
scripts/   sync-core.js (npm run build), serve-docs.js
test/      node --test suites
```
