// Database setup. Runs itself - there is no migration command to remember.
//
// On the first request after a deploy, this creates any missing tables and
// syncs the checklist in data/checklist.json into the database. Editing that
// file on GitHub is therefore the whole workflow for changing the checklist:
// push, wait for the deploy, done - right up until the first edit is made
// inside the app, after which the app owns the checklists and this stops.

import checklist from '../../data/checklist.json';

/** The two checklists every building has. 'both' puts an area on each. */
export const CLEAN_TYPES = ['full', 'check'];
export const CLEAN_TYPE_LABELS = { full: 'Full Clean', check: 'Check' };
export const isCleanType = (t) => CLEAN_TYPES.includes(t);

/** Whether a checklist item can carry photos, and whether it must. */
export const PHOTO_MODES = ['none', 'optional', 'required'];

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

  // A building's checklist is a flat list of broad areas to tick off -
  // "Bathrooms", "Shelter", "Stairwell and second floor" - not the individual
  // jobs inside them. The detail lives on the paper checklists the cleaners
  // already carry; the app records that the area was done, by whom, when.
  // 'both' is the escape hatch for anything shared by the Full Clean and the
  // Check (the "Every visit" block, mainly) so it is never kept in sync twice.
  `CREATE TABLE IF NOT EXISTS tasks (
     id          INTEGER PRIMARY KEY,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     clean_type  TEXT    NOT NULL DEFAULT 'both'
                 CHECK (clean_type IN ('full', 'check', 'both')),
     item        TEXT    NOT NULL,
     description TEXT    NOT NULL DEFAULT '',
     photo_mode  TEXT    NOT NULL DEFAULT 'none',
     sort_order  INTEGER NOT NULL DEFAULT 0,
     active      INTEGER NOT NULL DEFAULT 1,
     UNIQUE (building_id, clean_type, item)
   )`,

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

  // Photos attached to an individual checklist item on a given day. Separate
  // table (rather than a column) because an item can carry several.
  `CREATE TABLE IF NOT EXISTS task_photos (
     id         INTEGER PRIMARY KEY,
     task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     day        TEXT    NOT NULL,
     photo_key  TEXT    NOT NULL UNIQUE,
     bytes      INTEGER NOT NULL DEFAULT 0,
     user_id    INTEGER,
     user_name  TEXT    NOT NULL,
     created_at TEXT    NOT NULL
   )`,

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

  // One sign-off per building per day per cleaning type: a Check in the
  // morning and a Full Clean in the afternoon are two separate jobs.
  `CREATE TABLE IF NOT EXISTS building_status (
     id           INTEGER PRIMARY KEY,
     building_id  INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     day          TEXT    NOT NULL,
     clean_type   TEXT    NOT NULL DEFAULT 'full',
     completed_at TEXT    NOT NULL,
     completed_by TEXT    NOT NULL,
     UNIQUE (building_id, day, clean_type)
   )`,

  // Reports are maintenance only: something in a building needs fixing.
  // `location` is free text - "the tap by the back door".
  `CREATE TABLE IF NOT EXISTS maintenance (
     id          INTEGER PRIMARY KEY,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     location    TEXT    NOT NULL DEFAULT '',
     kind        TEXT    NOT NULL DEFAULT 'maintenance'
                 CHECK (kind IN ('maintenance')),
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

  // "This building needs this kind of clean on this day", with an order of
  // priority. One row per building per day. Deliberately not a list of who is
  // doing it: the plan says what needs doing, the roster says who is in.
  `CREATE TABLE IF NOT EXISTS schedule (
     id          INTEGER PRIMARY KEY,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     day         TEXT    NOT NULL,
     clean_type  TEXT    NOT NULL DEFAULT 'full',
     priority    INTEGER NOT NULL DEFAULT 1,
     note        TEXT,
     created_by  TEXT    NOT NULL,
     created_at  TEXT    NOT NULL,
     UNIQUE (building_id, day)
   )`,

  // The staff roster: who is working, when. Deliberately separate from
  // `schedule` (which is about buildings) - a shift exists whether or not any
  // particular building is on the plan that day.
  `CREATE TABLE IF NOT EXISTS roster (
     id         INTEGER PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     user_name  TEXT    NOT NULL,
     day        TEXT    NOT NULL,
     start_time TEXT    NOT NULL,
     end_time   TEXT    NOT NULL,
     duty       TEXT    NOT NULL DEFAULT '',
     note       TEXT    NOT NULL DEFAULT '',
     confirmed  INTEGER NOT NULL DEFAULT 0,
     created_by TEXT    NOT NULL,
     created_at TEXT    NOT NULL,
     updated_at TEXT    NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS login_attempts (
     ip       TEXT PRIMARY KEY,
     fails    INTEGER NOT NULL DEFAULT 0,
     until_ts INTEGER NOT NULL DEFAULT 0
   )`,
];

/**
 * Indexes are created after the migrations rather than alongside the tables,
 * because several of them name a column a migration is about to add: on an
 * upgrade the index would be built against the old shape and fail outright.
 */
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_tasks_building ON tasks (building_id, active)`,
  `CREATE INDEX IF NOT EXISTS idx_task_log_day ON task_log (day)`,
  `CREATE INDEX IF NOT EXISTS idx_task_photos ON task_photos (task_id, day)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_day ON activity (day, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance (status, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_schedule_day ON schedule (day, priority)`,
  `CREATE INDEX IF NOT EXISTS idx_roster_day ON roster (day, start_time)`,
  `CREATE INDEX IF NOT EXISTS idx_roster_user ON roster (user_id, day)`,
];


/* ------------------------------------------------------- checklist planning */

/**
 * Reads one checklist entry from checklist.json.
 *
 * ["Bathrooms"], optionally with a note and a photo flag:
 * ["Bathrooms", "Both blocks", "photo required"].
 */
function readTask([item, description, flag]) {
  const f = String(flag ?? '').toLowerCase();
  const photoMode = f.includes('required') ? 'required' : f.includes('photo') ? 'optional' : 'none';
  return { item, description: description ?? '', photoMode };
}

/**
 * Flattens checklist.json into the rows the DB stores: one flat list of
 * checklist entries per building.
 *
 * A building lists its entries under "full" and "check". An entry named on
 * both is stored once as 'both', so it is edited in one place and ticking it
 * counts either way. "Every visit" is appended to every building as 'both'.
 */
function plan() {
  const both = (checklist.everyVisit ?? []).map(readTask);

  return checklist.buildings.map((building, bIndex) => {
    const read = (list) => (list ?? []).map(readTask);
    const full = read(building.full);
    const check = read(building.check);

    // An entry on both lists is stored once, as 'both', so it is edited in
    // one place and ticking it counts for either kind of clean.
    const checkNames = new Set(check.map((t) => t.item));
    const shared = full.filter((t) => checkNames.has(t.item));
    const sharedNames = new Set(shared.map((t) => t.item));

    const items = [];
    let sort = 0;
    const push = (list, cleanType) => {
      for (const t of list) items.push({ ...t, cleanType, sort: sort++ });
    };
    push(full.filter((t) => !sharedNames.has(t.item)), 'full');
    push(check.filter((t) => !sharedNames.has(t.item)), 'check');
    push(shared, 'both');
    push(both, 'both');

    return { name: building.name, group: building.group ?? '', sort: bIndex, items };
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* -------------------------------------------------------------- migrations */

/**
 * Adds a column to an existing table if it isn't there yet. CREATE TABLE IF
 * NOT EXISTS can't do this, and ALTER TABLE errors when the column already
 * exists, so check first.
 */
async function ensureColumn(db, table, column, definition) {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
  // No rows means no such table - a table this version has dropped, on a
  // database old enough to still have had it. Nothing to add a column to.
  if (!results.length || results.some((c) => c.name === column)) return;
  await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

/** The stored CREATE TABLE statement, or '' when there is no such table. */
async function tableSql(db, table) {
  const row = await db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).bind(table).first();
  return row?.sql ?? '';
}

/** True when the stored CREATE TABLE statement doesn't mention `needle` yet. */
async function tableLacks(db, table, needle) {
  const sql = await tableSql(db, table);
  return Boolean(sql) && !sql.includes(needle);
}

/**
 * Reduces reports to the one kind that earns its place: maintenance.
 *
 * "Lost property" and the general "Note" were both really just "somebody
 * wrote something down", and the choice cost every reporter a decision at the
 * top of the form. The kinds are gone; the reports are not - every existing
 * one becomes a maintenance report and stays exactly where it was, detail and
 * photo intact.
 *
 * That means narrowing a CHECK constraint, and dropping `area_id` with it now
 * that "where" is free text. SQLite can't do either in place, so this is the
 * standard rebuild: create the new shape, copy the rows across, swap names.
 * `location` is carried over, so it has to already exist when this runs.
 */
async function ensureReportKinds(db) {
  const sql = await tableSql(db, 'maintenance');
  if (!sql || !(sql.includes("'note'") || sql.includes('area_id'))) return;

  await db.prepare(`CREATE TABLE maintenance_new (
     id          INTEGER PRIMARY KEY,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     location    TEXT    NOT NULL DEFAULT '',
     kind        TEXT    NOT NULL DEFAULT 'maintenance'
                 CHECK (kind IN ('maintenance')),
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
  // Columns listed out rather than SELECT *, so this keeps working when a
  // later migration has already added a column the new shape doesn't have.
  await db.prepare(
    `INSERT INTO maintenance_new
       (id, building_id, location, kind, detail, photo_key, status, day,
        reported_by, reported_at, resolved_by, resolved_at)
     SELECT id, building_id, location, 'maintenance', detail, photo_key, status, day,
        reported_by, reported_at, resolved_by, resolved_at FROM maintenance`,
  ).run();
  await db.prepare('DROP TABLE maintenance').run();
  await db.prepare('ALTER TABLE maintenance_new RENAME TO maintenance').run();

  // The activity log is free text, so its old entries only need relabelling.
  await db.prepare(
    `UPDATE activity SET kind = 'issue' WHERE kind IN ('note', 'lost_property')`,
  ).run();
}

/**
 * Same treatment for sign-offs: the unique key gains the cleaning type, so a
 * building can be checked in the morning and fully cleaned that afternoon
 * without one sign-off standing in for the other. Existing sign-offs become
 * 'full', which is what they were.
 */
async function ensureStatusCleanTypes(db) {
  if (!await tableLacks(db, 'building_status', 'clean_type')) return;

  await db.prepare(`CREATE TABLE building_status_new (
     id           INTEGER PRIMARY KEY,
     building_id  INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     day          TEXT    NOT NULL,
     clean_type   TEXT    NOT NULL DEFAULT 'full',
     completed_at TEXT    NOT NULL,
     completed_by TEXT    NOT NULL,
     UNIQUE (building_id, day, clean_type)
   )`).run();
  await db.prepare(
    `INSERT INTO building_status_new
       (id, building_id, day, clean_type, completed_at, completed_by)
     SELECT id, building_id, day, 'full', completed_at, completed_by FROM building_status`,
  ).run();
  await db.prepare('DROP TABLE building_status').run();
  await db.prepare('ALTER TABLE building_status_new RENAME TO building_status').run();
}

/**
 * Flattens a checklist that was stored as areas containing individual jobs.
 *
 * The checklist is now one level: a building has a list of broad areas to
 * tick ("Bathrooms", "Shelter"), and the detail lives on the paper checklists
 * the cleaners already carry. So `tasks` hangs off a building and a cleaning
 * type directly rather than off an area.
 *
 * Row ids are carried across, which is what keeps every tick and every photo
 * attached to the thing it was recorded against. The old fine-grained names
 * are prefixed with the area they belonged to - "Kitchen - Bins" - for two
 * reasons: the new unique key is (building, type, name) and "Bins" appeared
 * in several areas of the same building, and it keeps a year of exported
 * history readable instead of a column of bare "Bins".
 *
 * Nothing is deactivated here. On the normal path the checklist file is in
 * charge and the sync that follows retires these and inserts the new
 * categories; if an admin had taken the checklist over in the app, they keep
 * exactly what they had until they choose "Restore from file".
 *
 * The ticks and photos are lifted out to unconstrained side tables and put
 * back afterwards, because D1 enforces foreign keys: `DROP TABLE tasks` runs
 * an implicit DELETE, which fires the ON DELETE CASCADE on `task_log` and
 * `task_photos` and would take every tick and every photo in the park with it,
 * silently and with no error to notice.
 */
async function ensureFlatChecklist(db) {
  if (!await tableLacks(db, 'tasks', 'building_id')) return;

  // An `areas` table old enough to predate cleaning types has no clean_type
  // column to read. Those areas were on every clean, which is 'both'.
  const areaType = await tableLacks(db, 'areas', 'clean_type') ? `'both'` : 'a.clean_type';

  await db.prepare(`CREATE TABLE tasks_new (
     id          INTEGER PRIMARY KEY,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     clean_type  TEXT    NOT NULL DEFAULT 'both'
                 CHECK (clean_type IN ('full', 'check', 'both')),
     item        TEXT    NOT NULL,
     description TEXT    NOT NULL DEFAULT '',
     photo_mode  TEXT    NOT NULL DEFAULT 'none',
     sort_order  INTEGER NOT NULL DEFAULT 0,
     active      INTEGER NOT NULL DEFAULT 1,
     UNIQUE (building_id, clean_type, item)
   )`).run();

  await db.prepare(
    `INSERT INTO tasks_new
       (id, building_id, clean_type, item, description, photo_mode, sort_order, active)
     SELECT t.id, a.building_id, ${areaType}, a.name || ' - ' || t.item,
            t.description, t.photo_mode, t.sort_order, t.active
     FROM tasks t JOIN areas a ON a.id = t.area_id`,
  ).run();

  // CREATE TABLE ... AS SELECT makes a plain table with no foreign keys, so
  // the cascade below cannot reach these. Anything whose area had already
  // gone is left behind on purpose: it has nothing left to point at.
  await db.prepare(
    `CREATE TABLE task_log_kept AS
     SELECT * FROM task_log WHERE task_id IN (SELECT id FROM tasks_new)`,
  ).run();
  await db.prepare(
    `CREATE TABLE task_photos_kept AS
     SELECT * FROM task_photos WHERE task_id IN (SELECT id FROM tasks_new)`,
  ).run();

  await db.prepare('DROP TABLE tasks').run();
  await db.prepare('ALTER TABLE tasks_new RENAME TO tasks').run();

  // Empty either way - cleared by the cascade when foreign keys are enforced,
  // still full when they are not - so clear them before putting the kept rows
  // back, rather than assuming which happened.
  await db.prepare('DELETE FROM task_log').run();
  await db.prepare('DELETE FROM task_photos').run();
  // Both sides came from the same table moments ago, so the column order
  // matches by construction.
  await db.prepare('INSERT INTO task_log SELECT * FROM task_log_kept').run();
  await db.prepare('INSERT INTO task_photos SELECT * FROM task_photos_kept').run();
  await db.prepare('DROP TABLE task_log_kept').run();
  await db.prepare('DROP TABLE task_photos_kept').run();
}

/**
 * Drops the two tables this version no longer has anything to say about:
 * `areas`, now the checklist is one level deep, and `schedule_assignees`, now
 * that the plan records what needs cleaning rather than who is on it.
 *
 * Both are dropped only once everything that was worth keeping has been read
 * out of them - `areas` by the flatten above, which is the migration that
 * moves each task onto its building.
 */
async function dropRetiredTables(db) {
  await db.prepare('DROP TABLE IF EXISTS schedule_assignees').run();
  await db.prepare('DROP TABLE IF EXISTS areas').run();
}

/* --------------------------------------------------------- checklist sync */

/**
 * Composite map key. The separator is an explicit NUL escape because building
 * and area names can contain any printable character, including spaces and
 * punctuation, so nothing printable is safe to delimit on.
 */
const joinKey = (...parts) => parts.join('\u0000');

async function readSetting(db, key, fallback = null) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row?.value ?? fallback;
}

async function writeSetting(db, key, value) {
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(key, String(value)).run();
}

const BATCH = 50;

/**
 * Runs statements in bites rather than one enormous call, so a reworked
 * checklist doesn't ride on a single batch succeeding.
 */
async function runAll(db, statements) {
  for (let i = 0; i < statements.length; i += BATCH) {
    await db.batch(statements.slice(i, i + BATCH));
  }
}

/**
 * Writes the checklist into the database.
 *
 * Anything removed from checklist.json is deactivated rather than deleted, so
 * the record of what was cleaned in the past never breaks.
 */
async function syncChecklist(db) {
  const buildings = plan();

  await runAll(db, buildings.map((b) => db.prepare(
    `INSERT INTO buildings (name, grp, sort_order, active) VALUES (?, ?, ?, 1)
     ON CONFLICT(name) DO UPDATE SET
       grp = excluded.grp, sort_order = excluded.sort_order, active = 1`,
  ).bind(b.name, b.group, b.sort)));

  // Resolve ids in one pass so the entry upserts don't need sub-selects.
  const { results: buildingRows } = await db.prepare('SELECT id, name FROM buildings').all();
  const buildingId = new Map(buildingRows.map((r) => [r.name, r.id]));

  const { results: existing } = await db.prepare(
    'SELECT id, building_id, clean_type, item FROM tasks',
  ).all();

  // Match a planned entry to an existing row by (building, type, name) first,
  // then by name alone. The fallback is what stops an entry that moved
  // between the Full Clean and the Check from being inserted a second time
  // and stranding everything it has recorded.
  const exact = new Map();
  const byName = new Map();
  for (const r of existing) {
    exact.set(joinKey(r.building_id, r.clean_type, r.item), r);
    const key = joinKey(r.building_id, r.item);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  }

  const claimed = new Set();
  const updates = [];
  const inserts = [];

  for (const b of buildings) {
    const bid = buildingId.get(b.name);
    for (const t of b.items) {
      let row = exact.get(joinKey(bid, t.cleanType, t.item));
      if (row && claimed.has(row.id)) row = null;
      if (!row) {
        row = (byName.get(joinKey(bid, t.item)) ?? []).find((r) => !claimed.has(r.id)) ?? null;
      }

      if (row) {
        claimed.add(row.id);
        updates.push(db.prepare(
          `UPDATE tasks SET clean_type = ?, description = ?, photo_mode = ?,
             sort_order = ?, active = 1 WHERE id = ?`,
        ).bind(t.cleanType, t.description, t.photoMode, t.sort, row.id));
      } else {
        inserts.push(db.prepare(
          `INSERT INTO tasks
             (building_id, clean_type, item, description, photo_mode, sort_order, active)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
        ).bind(bid, t.cleanType, t.item, t.description, t.photoMode, t.sort));
      }
    }
  }

  await runAll(db, updates);
  await runAll(db, inserts);

  // Retire anything no longer in the checklist, rather than deleting it, so
  // the record of what was cleaned in the past never breaks.
  const stale = existing.filter((r) => !claimed.has(r.id)).map((r) => r.id);
  await runAll(db, stale.map((id) =>
    db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').bind(id)));

  const liveBuildings = new Set(buildings.map((b) => b.name));
  const retired = buildingRows.filter((r) => !liveBuildings.has(r.name)).map((r) => r.id);
  await runAll(db, retired.map((id) =>
    db.prepare('UPDATE buildings SET active = 0 WHERE id = ?').bind(id)));

  return {
    buildings: buildings.length,
    updated: updates.length,
    added: inserts.length,
    hidden: stale.length,
  };
}

/** The version marker for what data/checklist.json currently says. */
export const checklistVersion = () => sha256Hex(JSON.stringify(plan()));

/**
 * Rewrites the checklist from the file and records the version written.
 *
 * Exported because "Restore from file" has to do the work there and then: it
 * used to flip a setting and leave the writing to whenever the next isolate
 * happened to start up, so the screen refreshed onto the same old list and the
 * button looked like it had done nothing.
 */
export async function applyChecklistFile(db) {
  const counts = await syncChecklist(db);
  await writeSetting(db, 'checklist_version', await checklistVersion());
  return counts;
}

async function migrate(env, waitUntil) {
  const db = env.DB;
  if (!db) {
    throw new Error(
      'No database is connected yet. In the Cloudflare dashboard open this project, ' +
      'go to Settings > Bindings, add a D1 database binding named DB, then retry ' +
      'the deployment. This is steps 2, 3 and 5 in SETUP.md.',
    );
  }

  await db.batch(TABLES.map((sql) => db.prepare(sql)));

  // Every column an upgrade might be missing goes in first, because each of
  // the rebuilds below recreates its table from a fixed CREATE and copies the
  // columns by name: a column added afterwards is a column the rebuild would
  // have silently dropped on the way past.
  await ensureColumn(db, 'buildings', 'grp', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, 'users', 'availability', "TEXT NOT NULL DEFAULT '1111111'");
  await ensureColumn(db, 'tasks', 'photo_mode', "TEXT NOT NULL DEFAULT 'none'");
  await ensureColumn(db, 'schedule', 'clean_type', "TEXT NOT NULL DEFAULT 'full'");
  await ensureColumn(db, 'maintenance', 'location', "TEXT NOT NULL DEFAULT ''");

  await ensureReportKinds(db);
  await ensureStatusCleanTypes(db);
  await ensureFlatChecklist(db);
  // Last: the flatten above is the final reader of `areas`.
  await dropRetiredTables(db);

  await db.batch(INDEXES.map((sql) => db.prepare(sql)));

  // Once an admin edits the checklist inside the app, the app owns it and the
  // file stops being applied - otherwise the next deploy would quietly undo
  // their work. "Restore from file" in the admin screen hands control back.
  const source = await readSetting(db, 'checklist_source', 'file');

  // Only rewrite the checklist when its content actually changed.
  const version = await checklistVersion();
  if (source !== 'app' && await readSetting(db, 'checklist_version') !== version) {
    // A reworked checklist is hundreds of statements, and the first request
    // after that deploy was paying for all of them before it answered - long
    // enough that the page gave up and said the app hadn't started. The
    // tables above must exist before anything is served; this doesn't, so it
    // runs behind the response. The version is only written once it lands, so
    // a failure just means the next request tries again.
    // Logged rather than swallowed: behind the response, a rejection would
    // otherwise be invisible, and a checklist that quietly never syncs is
    // indistinguishable from one the file no longer owns.
    const job = applyChecklistFile(db).catch((err) => console.error('checklist sync', err));
    if (waitUntil) waitUntil(job); else await job;
  }

  // Old rate-limit rows serve no purpose once their lockout has expired, and
  // this table is otherwise append-only forever.
  await db.prepare('DELETE FROM login_attempts WHERE until_ts < ?')
    .bind(Date.now() - 86400_000).run();

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

export function ensureReady(env, waitUntil) {
  if (!pending) {
    pending = migrate(env, waitUntil).catch((err) => {
      pending = null; // let the next request retry rather than wedging the site
      throw err;
    });
  }
  return pending;
}

export const contacts = checklist.contacts ?? {};
