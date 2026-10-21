# Software Engineer - Technical Exercise: Payment Processing Platform

---

### 1. Overview

Build a simplified payment processing platform that allows merchants to create and
manage payment transactions.

The platform should include:

- a **backend API**,
- a **frontend dashboard**, and
- at least one **asynchronous / background workflow**.

The goal of this exercise is **not feature completeness**. It is to evaluate how you
think as an engineer: system design, code quality, architectural decisions,
operational thinking, and the engineering tradeoffs you make along the way.

We would rather see a small, well-built, well-reasoned slice of the system than a
broad but shallow implementation.

---

### 2. What We're Evaluating

- System design
- Code quality
- Architectural decisions
- Operational thinking
- Engineering tradeoffs

---

### 3. Functional Requirements

#### 3.1 Backend

Implement APIs to:

- log in to a merchant account
- create a payment
- retrieve payment details
- capture a payment
- refund a payment
- list / search payments

The payment APIs should only be usable by a logged-in merchant. How you authenticate
requests after login is up to you (for example, a signed token issued at login and
sent with each request). Be ready to explain the approach you chose, how a request is
validated, and how a login expires.

Payments should support lifecycle states such as:

`Pending` → `Authorized` → `Captured` → `Settled`
with `Failed` and `Refunded` as terminal / branch states.

At least one **asynchronous workflow** should exist in the system — for example:

- settlement processing,
- reconciliation, or
- webhook delivery.

#### 3.2 Frontend

Provide a simple dashboard that allows:

- logging in to a merchant account
- viewing payments
- filtering / searching
- viewing payment details and statuses

---

### 4. Observability & Operational Requirements

Operational maturity is a first-class evaluation criterion, not an afterthought.
A payments system that you cannot see into is a payments system you cannot trust.
We expect the implementation to demonstrate that you would be comfortable running
this in production.

#### 4.1 Logging

- **Structured logs** (e.g. JSON), not free-text, so they are queryable.
- A **correlation / request ID** propagated across the API and the async workflow,
  so a single payment's journey can be traced end to end.
- Sensible **log levels** (debug / info / warn / error) used deliberately.
- **No sensitive data in logs** — no full card numbers (PAN), CVV, or secrets.
  Show awareness of PCI-style handling even if you stub the actual card data.

#### 4.2 Metrics

- Service health metrics — request rate, error rate, latency (the "RED" signals).
- **Business / domain metrics** — payments created, captured, refunded, and failed,
  ideally broken down by lifecycle state.
- For the async workflow: **queue depth, processing lag, and retry/failure counts.**

#### 4.3 Tracing

- Ideally, a trace that spans the API request and the downstream asynchronous work,
  so latency and failures can be attributed to the right component.
- A clear story for how you would adopt distributed tracing even if you only stub it.

#### 4.4 Health & Lifecycle

- **Health / readiness endpoints** suitable for orchestrators and load balancers.
- An **audit trail of payment state transitions** — who/what changed a payment,
  when, and from which state to which state. This matters a great deal in payments.

#### 4.5 Error Handling & Resilience

- Consistent, well-structured API error responses.
- **Idempotency** for create/capture/refund so retries don't double-charge.
- A clear approach to retries, timeouts, and failure handling in the async workflow
  (e.g. retry with backoff, dead-letter handling).

> You are not expected to wire up a full observability stack. We are looking for the
> right *instrumentation seams* and a clear narrative of how it would work in production.

---

### 5. Technical Expectations

You may use any technologies / frameworks you prefer.

We are evaluating:

| Area | What we're looking for |
|---|---|
| Architecture & code organization | Clear boundaries, sensible structure |
| API design | Consistent, predictable, well-modeled |
| Frontend quality | Usable, clean, maintainable |
| Scalability considerations | How it would grow under load |
| Security awareness | Auth, data handling, PCI mindset |
| Operational maturity | Observability, logging, health, idempotency |
| Testing strategy | What you test, and why |
| Maintainability | Code a teammate could pick up |
| Observability & logging | See section 4 |

---

### 6. Deliverables — Documentation

Please include written documentation covering:

- **Setup instructions** — how to run it locally.
- **Architectural overview** — components and how they fit together.
- **Tradeoffs made** — what you chose and what you gave up.
- **Assumptions** — anything you decided where the brief was ambiguous.
- **Production considerations** — what would change before this is production-ready.
- **Areas for future improvement** — what you'd do with more time.

---

### 7. Additional Notes

- You may make **reasonable assumptions** where requirements are ambiguous —
  just write them down.
- You are encouraged to **prioritize depth and quality over feature completeness**.
- A focused, production-minded subset is more impressive than a broad, fragile whole.
