-- LinenTrack Database Schema

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS hotels (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  city         TEXT NOT NULL,
  rooms        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS laundry_providers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  contact      TEXT,
  sla_hours    INTEGER NOT NULL DEFAULT 24,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS linen_types (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  category              TEXT NOT NULL,
  max_washes            INTEGER NOT NULL DEFAULT 100,
  warning_pct           INTEGER NOT NULL DEFAULT 90,
  action_at_limit       TEXT NOT NULL DEFAULT 'flag' CHECK (action_at_limit IN ('flag','retire')),
  billing_rate          REAL NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('platform_admin','hotel_admin','hotel_manager','staff')),
  hotel_id      TEXT REFERENCES hotels(id),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  last_login    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS linens (
  id            TEXT PRIMARY KEY,
  linen_code    TEXT NOT NULL UNIQUE,
  rfid_tag      TEXT NOT NULL UNIQUE,
  linen_type_id TEXT NOT NULL REFERENCES linen_types(id),
  hotel_id      TEXT NOT NULL REFERENCES hotels(id),
  status        TEXT NOT NULL DEFAULT 'in_house' CHECK (status IN ('in_house','at_laundry','in_transit','missing','retired')),
  wash_count    INTEGER NOT NULL DEFAULT 0,
  enrolled_at   TEXT NOT NULL DEFAULT (datetime('now')),
  retired_at    TEXT,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_linens_hotel ON linens(hotel_id);
CREATE INDEX IF NOT EXISTS idx_linens_rfid ON linens(rfid_tag);
CREATE INDEX IF NOT EXISTS idx_linens_status ON linens(status);

CREATE TABLE IF NOT EXISTS batches (
  id                    TEXT PRIMARY KEY,
  batch_code            TEXT NOT NULL UNIQUE,
  hotel_id              TEXT NOT NULL REFERENCES hotels(id),
  laundry_provider_id   TEXT NOT NULL REFERENCES laundry_providers(id),
  dispatched_at         TEXT NOT NULL DEFAULT (datetime('now')),
  expected_return_at    TEXT NOT NULL,
  returned_at           TEXT,
  qr_acknowledged_at    TEXT,
  status                TEXT NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched','acknowledged','at_laundry','in_transit','returned','partially_returned','overdue')),
  notes                 TEXT,
  created_by            TEXT REFERENCES users(id),
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_batches_hotel ON batches(hotel_id);
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);

CREATE TABLE IF NOT EXISTS batch_items (
  id                TEXT PRIMARY KEY,
  batch_id          TEXT NOT NULL REFERENCES batches(id),
  linen_id          TEXT NOT NULL REFERENCES linens(id),
  wash_count_before INTEGER NOT NULL DEFAULT 0,
  returned_at       TEXT,
  return_status     TEXT CHECK (return_status IN ('good','stained','torn','rewash','retired')),
  rewash            INTEGER NOT NULL DEFAULT 0,
  UNIQUE(batch_id, linen_id)
);

CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_items_linen ON batch_items(linen_id);

CREATE TABLE IF NOT EXISTS boq (
  id            TEXT PRIMARY KEY,
  hotel_id      TEXT NOT NULL REFERENCES hotels(id),
  month         INTEGER NOT NULL,
  year          INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','under_review','finalized')),
  total_amount  REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_at  TEXT,
  finalized_by  TEXT REFERENCES users(id),
  UNIQUE(hotel_id, month, year)
);

CREATE TABLE IF NOT EXISTS boq_items (
  id              TEXT PRIMARY KEY,
  boq_id          TEXT NOT NULL REFERENCES boq(id),
  linen_type_id   TEXT NOT NULL REFERENCES linen_types(id),
  wash_count      INTEGER NOT NULL DEFAULT 0,
  rewash_count    INTEGER NOT NULL DEFAULT 0,
  billable_count  INTEGER NOT NULL DEFAULT 0,
  rate            REAL NOT NULL DEFAULT 0,
  amount          REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS alerts (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('missing','overdue','lifecycle','boq_ready','short_return')),
  severity    TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  hotel_id    TEXT REFERENCES hotels(id),
  linen_id    TEXT REFERENCES linens(id),
  batch_id    TEXT REFERENCES batches(id),
  message     TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  resolved_by TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_hotel ON alerts(hotel_id);
CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved);

CREATE TABLE IF NOT EXISTS support_tickets (
  id          TEXT PRIMARY KEY,
  ticket_code TEXT NOT NULL UNIQUE,
  hotel_id    TEXT REFERENCES hotels(id),
  created_by  TEXT REFERENCES users(id),
  issue_type  TEXT NOT NULL,
  priority    TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  batch_id    TEXT REFERENCES batches(id),
  linen_id    TEXT REFERENCES linens(id),
  description TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     TEXT,
  ip_address  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
