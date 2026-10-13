# FieldForge — Functional Specification

FieldForge is a clean-room simulator of a field-service management (FSM) SaaS for
residential/light-commercial HVAC, plumbing and electrical contractors. It is built
only from general, public knowledge of how FSM workflows operate (customers →
jobs → dispatch → estimates → invoices → payments → reporting). All names,
data, UI and code are original.

The simulator exists to be a **deterministic environment for software agents**:
a seeded world, a small set of well-defined actions with strict validation, and
checkable outcomes.

---

## 1. Simulated world

| Item | Value |
|---|---|
| Simulated "today" | `2026-03-09` (Monday), clock fixed at `10:00` |
| History | 120 days of past jobs; 14 days of future schedule |
| Companies | 3 (`CO-1` Ironleaf Comfort Services, `CO-2` Bluepeak Home Systems, `CO-3` Copperline Mechanical & Electric) |
| Technicians | 40 (14/13/13), each with 1–2 trades, a home zone and coordinates, a shift (07:00–16:00 or 08:00–17:00) |
| Customers | 1,000 (≈15% commercial), ≈1,130 locations |
| Jobs | ≈5,000 (completed, canceled, in progress, scheduled, unscheduled backlog) |
| Estimates | ≈650 (approved/declined/sent/draft) |
| Invoices / payments | ≈4,100 / ≈3,500 |
| Zones | Central (0,0), North (0,11), South (0,−11), East (11,0), West (−11,0) — miles on a flat plane |

The clock does not advance: actions are stamped with `today`/`10:00`. Anything
dated before `today` (or before 10:00 today) is "the past" and can't be scheduled into.

**Determinism.** `generateState(seed)` uses a single seeded PRNG (string hash →
mulberry32) consumed in a fixed order. The same seed yields a byte-identical
JSON state on every platform. Actions contain no randomness and no wall-clock reads,
so `seed + action log` fully determines any later state (`replay(seed, actions)`).

---

## 2. Core workflows

### 2.1 Customers & locations
* A **customer** belongs to exactly one company, is `residential` or `commercial`,
  has phone/email and a preferred channel (`prefersSms`).
* A customer has one or more **service locations** (address, city, zone, x/y).
  Work is always performed at a location.
* Actions: `createCustomer` (creates the primary location), `updateCustomer`, `addLocation`.

### 2.2 Jobs (work orders)
* A job has a trade, line items (from the price book or custom), a duration,
  priority (`low|normal|high|emergency`) and a job type
  (`service|repair|maintenance|install|inspection|emergency`).
* Status machine:

```
            scheduleJob                startJob              completeJob
unscheduled ───────────► scheduled ───────────► in_progress ───────────► completed
     ▲   ◄─────────────     │  ▲ (re)scheduleJob                 ▲
     │    unscheduleJob     │  └──────────┘                      │ completeJob (date ≤ today)
     │                      └────────────────────────────────────┘
     └─ any non-completed state ── cancelJob ──► canceled
```

* Duration defaults to the sum of price-book labor times, rounded up to 30 min, capped at 9 h.

### 2.3 Dispatch & technician scheduling
`scheduleJob(jobId, techId, date, start)` assigns or reschedules. It is rejected when:

| Code | Rule |
|---|---|
| `TECH_INACTIVE` | technician is deactivated |
| `WRONG_COMPANY` | technician belongs to another company |
| `TRADE_MISMATCH` | technician lacks the job's trade |
| `OUTSIDE_SHIFT` | `start … start+duration` not within the technician's shift |
| `CONFLICT` | overlaps another non-canceled job of that technician on that date |
| `PAST_SLOT` | date/time is before now |
| `INVALID_STATE` | job is not `unscheduled`/`scheduled` |

**Nearest technician.** Distance = Euclidean distance (miles, rounded to 0.01)
from the technician's home base to the job location. `findAvailableTechs` returns
technicians who pass every rule above, nearest first (ties by id).

The dispatch board shows technicians (rows) × time (07:00–18:00, 30-min grid) for
one company and date, with an unscheduled queue; drag & drop calls `scheduleJob` /
`unscheduleJob`.

### 2.4 Estimates
* `draft → sent → approved | declined`. `updateEstimate` allowed while draft/sent
  (custom lines may have negative prices, e.g. discounts).
* `approveEstimate` creates an **unscheduled job** with the estimate's items and
  links both ways (`estimate.jobId`, `job.estimateId`).

### 2.5 Invoices
* Created from a **completed** job (one non-void invoice per job) as `draft`.
* `sendInvoice` sets `sentAt` and due date (net 15 residential, net 30 commercial).
* Status is derived from payments: `draft | sent | partially_paid | paid`, or `void`.
* `voidInvoice` is rejected while completed payments exist (`HAS_PAYMENTS`).
* Tax = `round(max(subtotal,0) × company.taxRate)` (7.25% / 6% / 8.25%).

### 2.6 Payments
* `recordPayment(invoiceId, amountCents, method)` — `card|check|cash|ach`;
  amount must be positive and ≤ balance (`OVERPAYMENT`).
* `refundPayment` marks a payment `refunded` and reopens the invoice balance.

### 2.7 Notifications
Simulated outbound SMS/email are appended to the **notification log**
(`channel`, `to`, `template`, `message`, `refType`, `refId`). They are produced by
`notifyCustomer`, by `notify`/`sendReceipt` options on job/payment actions, and
automatically by `sendEstimate` and `sendInvoice`. Nothing is actually delivered.

### 2.8 Reports
`report({companyId?, from?, to?})` (default: the last 30 days):
jobs by status and trade, average ticket, invoiced vs collected revenue,
receivables aging (current / 1–30 / 31–60 / 61–90 / 90+ days past due),
estimate close rate, technician utilization (booked minutes ÷ shift minutes, Sundays excluded).

---

## 3. Data model

All money is **integer cents**; dates are `YYYY-MM-DD`; times are **minutes after
midnight** (actions also accept `"HH:MM"`). IDs are sequential per type.

```
Company      { id 'CO-n', name, city, state, taxRate, zones[], phone }
Technician   { id 'TEC-nnn', companyId, name, trades[], zone, homeX, homeY,
               shiftStart, shiftEnd, hourlyRateCents, phone, color, active }
Customer     { id 'CUS-nnnnn', companyId, name, type, phone, email, prefersSms, notes, createdAt }
Location     { id 'LOC-nnnnn', customerId, companyId, label, address, city, zone, x, y }
LineItem     { code|null, description, qty, unitPriceCents }
Job          { id 'JOB-nnnnnn', companyId, customerId, locationId, trade, jobType, priority,
               summary, items[], durationMin, status, techId, date, startMin, estimateId,
               createdAt, completedAt, canceledAt, cancelReason, notes }
Estimate     { id 'EST-nnnnn', companyId, customerId, locationId, trade, summary, items[],
               subtotalCents, taxCents, totalCents, status, createdAt, sentAt, decidedAt,
               declineReason, jobId }
Invoice      { id 'INV-nnnnn', companyId, customerId, jobId, items[], subtotalCents, taxCents,
               totalCents, amountPaidCents, status, createdAt, sentAt, dueDate, voidedAt, voidReason }
Payment      { id 'PAY-nnnnn', companyId, customerId, invoiceId, amountCents, method, date,
               status 'completed'|'refunded', refundedAt, note }
Notification { id 'NTF-nnnnn', companyId, customerId, channel, to, template, message,
               refType, refId, sentAt }
ActionLog    { seq, type, params }          // successful actions only
State        { meta {schema, seed, today, nowMin, counters}, companies[], technicians[],
               customers[], locations[], jobs[], estimates[], invoices[], payments[],
               notifications[], actionLog[] }
```

Relationships: Company 1─* Technician/Customer; Customer 1─* Location/Job/Estimate/Invoice/Payment/Notification;
Location 1─* Job; Estimate 0..1─1 Job; Job 1─* Invoice (≤1 non-void); Invoice 1─* Payment.

### Invariants (`validateState`)
* scheduled / in-progress jobs have a technician of the same company with the job's trade, inside the shift;
* no two non-canceled jobs of one technician overlap on a date;
* unscheduled jobs carry no tech/date/time;
* invoice totals match their items; `amountPaidCents` = sum of completed payments ≤ total; void invoices have no payments;
* approved estimates link to an existing job.

---

## 4. Price book (excerpt)

| Code | Trade | Service | Price | Labor |
|---|---|---|---|---|
| HV-DIAG | HVAC | HVAC diagnostic visit | $89 | 60 |
| HV-TUNE | HVAC | Seasonal AC/furnace tune-up | $129 | 60 |
| HV-AC3T | HVAC | Central AC replacement (3 ton) | $6,850 | 480 |
| PL-LEAK | Plumbing | Pipe leak repair | $245 | 90 |
| PL-WH40 | Plumbing | 40 gal water heater replacement | $1,890 | 240 |
| EL-DIAG | Electrical | Electrical troubleshooting visit | $99 | 60 |
| EL-PANL | Electrical | 200A panel upgrade | $3,450 | 480 |

The full list (27 services) is in `core/catalog.js` and via the `priceBook` query. Code `PARTS` is a custom materials line.

---

## 5. Architecture

```
core/        shared ES modules (no dependencies) — used verbatim by browser and Node
  prng.js      seeded PRNG            seed.js     world generator
  catalog.js   static reference data  model.js    ids, totals, scheduling rules
  actions.js   ACTIONS registry       queries.js  QUERIES registry + report
  validate.js  invariants             engine.js   createEngine / runAction / replay
docs/        static SPA for GitHub Pages (docs/core is a synced copy of core/)
server/      Express REST API over one in-memory engine
tasks/       30 agent tasks, task kinds (candidates/prompt/solve/check), generator, runner
test/        node --test suites
```
