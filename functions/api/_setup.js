// Database setup. Runs itself - there is no migration command to remember.
//
// On the first request after a deploy, this creates any missing tables and
// syncs the checklist in data/checklist.json into the database. Editing that
// file on GitHub is therefore the whole workflow for changing the checklist:
// push, wait for the deploy, done.

import checklist from '../../data/checklist.json';

const TABLES = [
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS users (
     id         INTEGER PRIMARY KEY,
     name       TEXT    NOT NULL,
     role       TEXT    NOT NULL CHECK (role IN ('cleaner', 'office', 'admin')),
     pin_hash   TEXT    NOT NULL UNIQUE,
     active     INTEGER NOT NULL DEFAULT 1,
     availability TEXT  NOT NULL DEFAULT '1111111',
     created_at TEXT    NOT NULL DEFAULT (datetime('now'))
   )`,

  `CREATE TABLE IF NOT EXISTS buildings (
     id         INTEGER PRIMARY KEY,
     name       TEXT    NOT NULL UNIQUE,
     grp        TEXT    NOT NULL DEFAULT '',
     sort_order INTEGER NOT NULL DEFAULT 0,
     active     INTEGER NOT NULL DEFAULT 1
   )`,

  `CREATE TABLE IF NOT EXISTS areas (
     id          INTEGER PRIMARY KEY,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     name        TEXT    NOT NULL,
     sort_order  INTEGER NOT NULL DEFAULT 0,
     active      INTEGER NOT NULL DEFAULT 1,
     UNIQUE (building_id, name)
   )`,

  `CREATE TABLE IF NOT EXISTS tasks (
     id          INTEGER PRIMARY KEY,
     area_id     INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
     item        TEXT    NOT NULL,
     description TEXT    NOT NULL DEFAULT '',
     sort_order  INTEGER NOT NULL DEFAULT 0,
     active      INTEGER NOT NULL DEFAULT 1,
     UNIQUE (area_id, item)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_area ON tasks (area_id, active)`,

  // Current state of every task, per cleaning day.
  `CREATE TABLE IF NOT EXISTS task_log (
     id         INTEGER PRIMARY KEY,
     task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     day        TEXT    NOT NULL,
     done       INTEGER NOT NULL DEFAULT 0,
     user_id    INTEGER REFERENCES users(id),
     user_name  TEXT,
     updated_at TEXT    NOT NULL,
     UNIQUE (task_id, day)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_task_log_day ON task_log (day)`,

  // Append-only history: who ticked what, when.
  `CREATE TABLE IF NOT EXISTS activity (
     id          INTEGER PRIMARY KEY,
     day         TEXT    NOT NULL,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     kind        TEXT    NOT NULL,
     detail      TEXT    NOT NULL,
     user_name   TEXT    NOT NULL,
     created_at  TEXT    NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_day ON activity (day, id DESC)`,

  `CREATE TABLE IF NOT EXISTS building_status (
     id           INTEGER PRIMARY KEY,
     building_id  INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     day          TEXT    NOT NULL,
     completed_at TEXT    NOT NULL,
     completed_by TEXT    NOT NULL,
     UNIQUE (building_id, day)
   )`,

  `CREATE TABLE IF NOT EXISTS maintenance (
     id          INTEGER PRIMARY KEY,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     area_id     INTEGER REFERENCES areas(id) ON DELETE SET NULL,
     kind        TEXT    NOT NULL DEFAULT 'maintenance'
                 CHECK (kind IN ('maintenance', 'lost_property', 'note')),
     detail      TEXT    NOT NULL,
     photo_key   TEXT,
     status      TEXT    NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'resolved')),
     day         TEXT    NOT NULL,
     reported_by TEXT    NOT NULL,
     reported_at TEXT    NOT NULL,
     resolved_by TEXT,
     resolved_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance (status, id DESC)`,

  // "This building needs cleaning on this day", with an order of priority.
  // One row per building per day.
  `CREATE TABLE IF NOT EXISTS schedule (
     id          INTEGER PRIMARY KEY,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     day         TEXT    NOT NULL,
     priority    INTEGER NOT NULL DEFAULT 1,
     note        TEXT,
     created_by  TEXT    NOT NULL,
     created_at  TEXT    NOT NULL,
     UNIQUE (building_id, day)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_schedule_day ON schedule (day, priority)`,

  // Who is meant to clean it. Separate table because more than one cleaner
  // can be put on the same building.
  `CREATE TABLE IF NOT EXISTS schedule_assignees (
     id          INTEGER PRIMARY KEY,
     schedule_id INTEGER NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
     user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     user_name   TEXT    NOT NULL,
     UNIQUE (schedule_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_assignees_user ON schedule_assignees (user_id)`,

  `CREATE TABLE IF NOT EXISTS login_attempts (
     ip       TEXT PRIMARY KEY,
     fails    INTEGER NOT NULL DEFAULT 0,
     until_ts INTEGER NOT NULL DEFAULT 0
   )`,
];

/**
 * Flattens checklist.json into the building/area/task shape the DB stores.
 *
 * A building's "areas" entry is either a template name (a string) or an
 * inline { name, tasks }. "Every visit" is appended to every building.
 */
function plan() {
  const templates = checklist.templates ?? {};

  return checklist.buildings.map((building, bIndex) => {
    const areas = (building.areas ?? []).map((entry) => {
      if (typeof entry !== 'string') return entry;
      const tasks = templates[entry];
      if (!tasks) throw new Error(`Unknown template "${entry}" on ${building.name}.`);
      return { name: entry, tasks };
    });

    if (checklist.everyVisit?.length) {
      areas.push({ name: 'Every visit', tasks: checklist.everyVisit });
    }

    return {
      name: building.name,
      group: building.group ?? '',
      sort: bIndex,
      areas: areas.map((area, aIndex) => ({
        name: area.name,
        sort: aIndex,
        tasks: area.tasks.map(([item, description], tIndex) => ({
          item, description, sort: tIndex,
        })),
      })),
    };
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Adds a column to an existing table if it isn't there yet. CREATE TABLE IF
 * NOT EXISTS can't do this, and ALTER TABLE errors when the column already
 * exists, so check first.
 */
async function ensureColumn(db, table, column, definition) {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
  if (results.some((c) => c.name === column)) return;
  await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

/**
 * The `maintenance` table's CHECK constraint originally only allowed
 * 'maintenance' and 'lost_property'. SQLite can't widen a CHECK constraint
 * in place, so adding the 'note' kind means rebuilding the table - the
 * standard SQLite move: create the new shape, copy the rows across, swap
 * names. Skipped once the constraint already mentions 'note'.
 */
async function ensureNoteKind(db) {
  const row = await db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'maintenance'`,
  ).first();
  if (!row || row.sql.includes("'note'")) return;

  await db.prepare(`CREATE TABLE maintenance_new (
     id          INTEGER PRIMARY KEY,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     area_id     INTEGER REFERENCES areas(id) ON DELETE SET NULL,
     kind        TEXT    NOT NULL DEFAULT 'maintenance'
                 CHECK (kind IN ('maintenance', 'lost_property', 'note')),
     detail      TEXT    NOT NULL,
     photo_key   TEXT,
     status      TEXT    NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'resolved')),
     day         TEXT    NOT NULL,
     reported_by TEXT    NOT NULL,
     reported_at TEXT    NOT NULL,
     resolved_by TEXT,
     resolved_at TEXT
   )`).run();
  await db.prepare('INSERT INTO maintenance_new SELECT * FROM maintenance').run();
  await db.prepare('DROP TABLE maintenance').run();
  await db.prepare('ALTER TABLE maintenance_new RENAME TO maintenance').run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance (status, id DESC)',
  ).run();
}

/**
 * Composite map key. The separator is an explicit NUL escape because building
 * and area names can contain any printable character, including spaces and
 * punctuation, so nothing printable is safe to delimit on.
 */
const joinKey = (a, b) => `${a}\u0000${b}`;

async function readSetting(db, key, fallback = null) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row?.value ?? fallback;
}

/**
 * Writes the checklist into the database.
 *
 * Anything removed from checklist.json is deactivated rather than deleted, so
 * the record of what was cleaned in the past never breaks.
 */
async function syncChecklist(db) {
  const buildings = plan();
  const statements = [];

  for (const b of buildings) {
    statements.push(
      db.prepare(
        `INSERT INTO buildings (name, grp, sort_order, active) VALUES (?, ?, ?, 1)
         ON CONFLICT(name) DO UPDATE SET
           grp = excluded.grp, sort_order = excluded.sort_order, active = 1`,
      ).bind(b.name, b.group, b.sort),
    );
  }
  await db.batch(statements);

  // Resolve ids in one pass so the task upserts don't need sub-selects.
  const { results: buildingRows } = await db.prepare(
    'SELECT id, name FROM buildings',
  ).all();
  const buildingId = new Map(buildingRows.map((r) => [r.name, r.id]));

  const areaStatements = [];
  for (const b of buildings) {
    for (const a of b.areas) {
      areaStatements.push(
        db.prepare(
          `INSERT INTO areas (building_id, name, sort_order, active) VALUES (?, ?, ?, 1)
           ON CONFLICT(building_id, name) DO UPDATE SET
             sort_order = excluded.sort_order, active = 1`,
        ).bind(buildingId.get(b.name), a.name, a.sort),
      );
    }
  }
  await db.batch(areaStatements);

  const { results: areaRows } = await db.prepare(
    'SELECT id, building_id, name FROM areas',
  ).all();
  const areaId = new Map(areaRows.map((r) => [joinKey(r.building_id, r.name), r.id]));

  const taskStatements = [];
  const keep = [];
  for (const b of buildings) {
    for (const a of b.areas) {
      const aid = areaId.get(joinKey(buildingId.get(b.name), a.name));
      for (const t of a.tasks) {
        keep.push(joinKey(aid, t.item));
        taskStatements.push(
          db.prepare(
            `INSERT INTO tasks (area_id, item, description, sort_order, active)
             VALUES (?, ?, ?, ?, 1)
             ON CONFLICT(area_id, item) DO UPDATE SET
               description = excluded.description,
               sort_order  = excluded.sort_order,
               active      = 1`,
          ).bind(aid, t.item, t.description, t.sort),
        );
      }
    }
  }
  await db.batch(taskStatements);

  // Retire anything no longer in the checklist.
  const { results: allTasks } = await db.prepare(
    'SELECT t.id, t.area_id, t.item FROM tasks t WHERE t.active = 1',
  ).all();
  const stale = allTasks
    .filter((t) => !keep.includes(joinKey(t.area_id, t.item)))
    .map((t) => t.id);
  if (stale.length) {
    await db.batch(stale.map((id) =>
      db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').bind(id)));
  }

  const liveBuildings = new Set(buildings.map((b) => b.name));
  const retired = buildingRows.filter((r) => !liveBuildings.has(r.name)).map((r) => r.id);
  if (retired.length) {
    await db.batch(retired.map((id) =>
      db.prepare('UPDATE buildings SET active = 0 WHERE id = ?').bind(id)));
  }
}

async function migrate(env) {
  const db = env.DB;
  if (!db) {
    throw new Error(
      'No database is connected yet. In the Cloudflare dashboard open this project, ' +
      'go to Settings > Bindings, add a D1 database binding named DB, then retry ' +
      'the deployment. This is steps 2, 3 and 5 in SETUP.md.',
    );
  }

  await db.batch(TABLES.map((sql) => db.prepare(sql)));
  await ensureColumn(db, 'buildings', 'grp', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, 'areas', 'active', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn(db, 'users', 'availability', "TEXT NOT NULL DEFAULT '1111111'");
  await ensureNoteKind(db);

  // Once an admin edits the checklist inside the app, the app owns it and the
  // file stops being applied - otherwise the next deploy would quietly undo
  // their work. "Restore from file" in the admin screen hands control back.
  const source = await readSetting(db, 'checklist_source', 'file');

  // Only rewrite the checklist when its content actually changed.
  const version = await sha256Hex(JSON.stringify(plan()));
  if (source !== 'app' && await readSetting(db, 'checklist_version') !== version) {
    await syncChecklist(db);
    await db.prepare(
      `INSERT INTO settings (key, value) VALUES ('checklist_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(version).run();
  }

  // The key that signs sessions and hashes PINs. Set AUTH_SECRET in the
  // dashboard to override; otherwise one is generated and kept in the
  // database so there is nothing to configure by hand.
  if (env.AUTH_SECRET && env.AUTH_SECRET.length >= 16) return env.AUTH_SECRET;

  const generated = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  // INSERT OR IGNORE + re-read, so simultaneous first requests agree on one value.
  await db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('auth_secret', ?)`,
  ).bind(generated).run();
  return readSetting(db, 'auth_secret');
}

// Cached per isolate: the work above happens once, not once per request.
let pending = null;

export function ensureReady(env) {
  if (!pending) {
    pending = migrate(env).catch((err) => {
      pending = null; // let the next request retry rather than wedging the site
      throw err;
    });
  }
  return pending;
}

export const contacts = checklist.contacts ?? {};
