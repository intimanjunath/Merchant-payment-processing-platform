CREATE TABLE merchants (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,                  -- Argon2id encoded string
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX merchants_email_key ON merchants (lower(email));

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  merchant_id uuid NOT NULL REFERENCES merchants (id),
  client_kind text NOT NULL CHECK (client_kind IN ('browser', 'api')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX sessions_merchant_idx ON sessions (merchant_id);

-- Fixed-window failure counters. subject_hash is SHA-256 of the normalized
-- email or client IP, so the table does not retain raw emails or addresses.
CREATE TABLE login_attempts (
  scope        text NOT NULL CHECK (scope IN ('email', 'ip')),
  subject_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  failures     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, subject_hash, window_start)
);
