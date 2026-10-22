CREATE SCHEMA provider;

CREATE TABLE provider.charges (
  id                 text PRIMARY KEY,          -- 'ch_' + random; returned as provider_payment_id
  token              text NOT NULL,
  amount_cents       bigint NOT NULL,
  status             text NOT NULL CHECK (status IN ('authorized', 'captured', 'refunded')),
  authorized_at      timestamptz NOT NULL DEFAULT now(),
  captured_at        timestamptz,
  funds_available_at timestamptz,               -- captured_at + SETTLEMENT_DELAY_MS
  refunded_at        timestamptz
);

-- One row per provider key. The primary key deduplicates concurrent calls and
-- serializes authorize against lookup-and-mark-not-received.
CREATE TABLE provider.requests (
  provider_key text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('authorize', 'capture', 'refund')),
  charge_id    text REFERENCES provider.charges (id),
  outcome      text NOT NULL CHECK (outcome IN ('succeeded', 'declined', 'rejected', 'not_received')),
  code         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Test-only fault injection; never written by HTTP handlers.
CREATE TABLE provider.injected_faults (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('authorize', 'capture', 'refund')),
  charge_id   text,                             -- null matches any charge
  fault       text NOT NULL CHECK (fault IN ('timeout_before_effect', 'lost_response', 'reject')),
  consumed_at timestamptz
);
