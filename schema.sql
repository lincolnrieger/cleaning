-- Basecamp Cleaning Tracker - database schema (Cloudflare D1 / SQLite)
-- Safe to re-run: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('cleaner', 'office', 'admin')),
  pin_hash    TEXT    NOT NULL UNIQUE,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS buildings (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS areas (
  id          INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (building_id, name)
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY,
  area_id     INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  item        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tasks_area ON tasks (area_id, active);

-- Current state of every task, per cleaning day. One row per task per day.
CREATE TABLE IF NOT EXISTS task_log (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  day         TEXT    NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  user_id     INTEGER REFERENCES users(id),
  user_name   TEXT,
  updated_at  TEXT    NOT NULL,
  UNIQUE (task_id, day)
);
CREATE INDEX IF NOT EXISTS idx_task_log_day ON task_log (day);

-- Append-only history: who ticked what, when. Never updated.
CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY,
  day         TEXT    NOT NULL,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  detail      TEXT    NOT NULL,
  user_name   TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_day ON activity (day, id DESC);

-- Cleaner sign-off: "this building is done for today".
CREATE TABLE IF NOT EXISTS building_status (
  id           INTEGER PRIMARY KEY,
  building_id  INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  day          TEXT    NOT NULL,
  completed_at TEXT    NOT NULL,
  completed_by TEXT    NOT NULL,
  UNIQUE (building_id, day)
);

CREATE TABLE IF NOT EXISTS maintenance (
  id          INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  area_id     INTEGER REFERENCES areas(id) ON DELETE SET NULL,
  kind        TEXT    NOT NULL DEFAULT 'maintenance' CHECK (kind IN ('maintenance', 'lost_property')),
  detail      TEXT    NOT NULL,
  photo_key   TEXT,
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  day         TEXT    NOT NULL,
  reported_by TEXT    NOT NULL,
  reported_at TEXT    NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance (status, id DESC);

-- Throttles PIN guessing. Rows are disposable.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip       TEXT PRIMARY KEY,
  fails    INTEGER NOT NULL DEFAULT 0,
  until_ts INTEGER NOT NULL DEFAULT 0
);
