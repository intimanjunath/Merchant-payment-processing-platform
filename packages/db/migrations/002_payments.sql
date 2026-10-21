CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE payments (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  merchant_id          uuid NOT NULL REFERENCES merchants (id),
  amount_cents         bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  currency             char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  reference            text NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 100),
  payment_method_token text NOT NULL,
  card_brand           text NOT NULL,
  card_last4           char(4) NOT NULL CHECK (card_last4 ~ '^[0-9]{4}$'),
  state                text NOT NULL CHECK (state IN
                         ('pending', 'authorized', 'captured', 'settled', 'failed', 'refunded')),
  failure_reason       text,
  provider_payment_id  text,
  settlement_review    boolean NOT NULL DEFAULT false,
  version              integer NOT NULL DEFAULT 0,   -- compare-and-set on finalize only
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'failed') = (failure_reason IS NOT NULL))
);
CREATE INDEX payments_merchant_created_idx
  ON payments (merchant_id, created_at DESC, id DESC);
CREATE INDEX payments_merchant_state_created_idx
  ON payments (merchant_id, state, created_at DESC, id DESC);
CREATE INDEX payments_reference_trgm_idx
  ON payments USING gin (reference gin_trgm_ops);
CREATE UNIQUE INDEX payments_provider_payment_id_key
  ON payments (provider_payment_id) WHERE provider_payment_id IS NOT NULL;

CREATE TABLE operations (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  merchant_id       uuid NOT NULL REFERENCES merchants (id),
  payment_id        uuid NOT NULL REFERENCES payments (id),
  action            text NOT NULL CHECK (action IN ('authorize', 'capture', 'refund')),
  idempotency_scope text NOT NULL,     -- 'create', 'capture:<payment_id>' or 'refund:<payment_id>'
  idempotency_key   text NOT NULL CHECK (idempotency_key ~ '^[\x21-\x7E]{1,128}$'),
  request_hash      text NOT NULL,     -- SHA-256 hex of normalized input
  provider_key      text NOT NULL UNIQUE,
  expected_version  integer NOT NULL,  -- payments.version at reservation; finalize compares against it
  status            text NOT NULL CHECK (status IN
                      ('reserved', 'awaiting_confirmation', 'needs_review', 'succeeded', 'rejected')),
  reason            text,
  response_status   smallint,          -- saved final response, null while unresolved
  response_body     jsonb,
  request_id        text NOT NULL,
  traceparent       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CHECK ((status IN ('succeeded', 'rejected')) = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX operations_idempotency_key
  ON operations (merchant_id, idempotency_scope, idempotency_key);
CREATE UNIQUE INDEX operations_one_unresolved_per_payment
  ON operations (payment_id)
  WHERE status IN ('reserved', 'awaiting_confirmation', 'needs_review');
CREATE INDEX operations_payment_created_idx ON operations (payment_id, created_at);

CREATE TABLE jobs (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  type                 text NOT NULL CHECK (type IN ('operation_recovery', 'settlement')),
  work_key             text NOT NULL UNIQUE,   -- 'recover:<operation_id>' or 'settle:<payment_id>'
  payment_id           uuid NOT NULL REFERENCES payments (id),
  operation_id         uuid REFERENCES operations (id),
  status               text NOT NULL CHECK (status IN
                         ('queued', 'running', 'paused', 'completed', 'cancelled')),
  due_at               timestamptz NOT NULL,
  attempts             integer NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  lease_owner          text,
  lease_expires_at     timestamptz,
  lease_generation     bigint NOT NULL DEFAULT 0,
  review_deadline      timestamptz NOT NULL,
  paused_reason        text,
  last_error           text,
  request_id           text NOT NULL,
  traceparent          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  CHECK ((type = 'operation_recovery') = (operation_id IS NOT NULL)),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX jobs_queued_due_idx ON jobs (due_at) WHERE status = 'queued';
CREATE INDEX jobs_running_lease_idx ON jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX jobs_paused_idx ON jobs (type) WHERE status = 'paused';

CREATE TABLE audit_events (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  payment_id   uuid NOT NULL REFERENCES payments (id),
  merchant_id  uuid NOT NULL REFERENCES merchants (id),
  from_state   text,                   -- null for creation
  to_state     text NOT NULL,
  actor        text NOT NULL,          -- 'merchant:<id>' or 'system:settlement'
  source       text NOT NULL CHECK (source IN ('api', 'worker')),
  reason       text NOT NULL,
  operation_id uuid REFERENCES operations (id),
  request_id   text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, to_state)        -- each state is entered at most once
);
CREATE INDEX audit_events_payment_time_idx ON audit_events (payment_id, occurred_at);

CREATE FUNCTION audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
CREATE TRIGGER audit_events_no_change
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
