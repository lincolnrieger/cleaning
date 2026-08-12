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

  // An area belongs to one building and one cleaning type. 'both' is the
  // escape hatch for anything shared by the Full Clean and the Check (the
  // "Every visit" block, mainly) so it never has to be kept in sync twice.
  `CREATE TABLE IF NOT EXISTS areas (
     id          INTEGER PRIMARY KEY,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     name        TEXT    NOT NULL,
     clean_type  TEXT    NOT NULL DEFAULT 'both'
                 CHECK (clean_type IN ('full', 'check', 'both')),
     sort_order  INTEGER NOT NULL DEFAULT 0,
     active      INTEGER NOT NULL DEFAULT 1,
     UNIQUE (building_id, clean_type, name)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_areas_building ON areas (building_id, active)`,

  `CREATE TABLE IF NOT EXISTS tasks (
     id          INTEGER PRIMARY KEY,
     area_id     INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
     item        TEXT    NOT NULL,
     description TEXT    NOT NULL DEFAULT '',
     photo_mode  TEXT    NOT NULL DEFAULT 'none',
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
  `CREATE INDEX IF NOT EXISTS idx_task_photos ON task_photos (task_id, day)`,

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

  `CREATE TABLE IF NOT EXISTS maintenance (
     id          INTEGER PRIMARY KEY,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     area_id     INTEGER REFERENCES areas(id) ON DELETE SET NULL,
     location    TEXT    NOT NULL DEFAULT '',
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

  // "This building needs this kind of clean on this day", with an order of
  // priority. One row per building per day.
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
  `CREATE INDEX IF NOT EXISTS idx_roster_day ON roster (day, start_time)`,
  `CREATE INDEX IF NOT EXISTS idx_roster_user ON roster (user_id, day)`,

  `CREATE TABLE IF NOT EXISTS login_attempts (
     ip       TEXT PRIMARY KEY,
     fails    INTEGER NOT NULL DEFAULT 0,
     until_ts INTEGER NOT NULL DEFAULT 0
   )`,
];

/* ------------------------------------------------------- checklist planning */

/**
 * Reads one task entry from checklist.json.
 *
 * ["Item", "What to do"] with an optional third value: "photo" to allow a
 * photo against the item, "photo required" to insist on one.
 */
function readTask([item, description, flag], sort) {
  const f = String(flag ?? '').toLowerCase();
  const photoMode = f.includes('required') ? 'required' : f.includes('photo') ? 'optional' : 'none';
  return { item, description: description ?? '', photoMode, sort };
}

/**
 * Flattens checklist.json into the building/area/task shape the DB stores.
 *
 * A building lists its areas under "full" and "check"; each entry is either a
 * template name (a string) or an inline { name, tasks }. An area named in both
 * lists is stored once as 'both'. "Every visit" is appended to every building
 * as a 'both' area, so it shows on either kind of clean without being kept in
 * two places. `areas` is still read as a synonym for "on both lists", which is
 * what every checklist file looked like before cleaning types existed.
 */
function plan() {
  const templates = checklist.templates ?? {};

  const resolve = (entry, building) => {
    if (typeof entry !== 'string') return entry;
    const tasks = templates[entry];
    if (!tasks) throw new Error(`Unknown template "${entry}" on ${building.name}.`);
    return { name: entry, tasks };
  };

  return checklist.buildings.map((building, bIndex) => {
    const byType = {
      full: (building.full ?? []).map((e) => resolve(e, building)),
      check: (building.check ?? []).map((e) => resolve(e, building)),
      both: (building.areas ?? []).map((e) => resolve(e, building)),
    };

    // An area listed under both types is stored once, as 'both'.
    const fullNames = new Set(byType.full.map((a) => a.name));
    const shared = byType.check.filter((a) => fullNames.has(a.name));
    if (shared.length) {
      const sharedNames = new Set(shared.map((a) => a.name));
      byType.both.push(...byType.full.filter((a) => sharedNames.has(a.name)));
      byType.full = byType.full.filter((a) => !sharedNames.has(a.name));
      byType.check = byType.check.filter((a) => !sharedNames.has(a.name));
    }

    if (checklist.everyVisit?.length) {
      byType.both.push({ name: 'Every visit', tasks: checklist.everyVisit });
    }

    const areas = [];
    let sort = 0;
    for (const type of ['full', 'check', 'both']) {
      for (const area of byType[type]) {
        areas.push({
          name: area.name,
          cleanType: type,
          sort: sort++,
          tasks: area.tasks.map(readTask),
        });
      }
    }

    return { name: building.name, group: building.group ?? '', sort: bIndex, areas };
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
  if (results.some((c) => c.name === column)) return;
  await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

/** True when the stored CREATE TABLE statement doesn't mention `needle` yet. */
async function tableLacks(db, table, needle) {
  const row = await db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).bind(table).first();
  return Boolean(row) && !row.sql.includes(needle);
}

/**
 * The `maintenance` table's CHECK constraint originally only allowed
 * 'maintenance' and 'lost_property'. SQLite can't widen a CHECK constraint
 * in place, so adding the 'note' kind means rebuilding the table - the
 * standard SQLite move: create the new shape, copy the rows across, swap
 * names. Skipped once the constraint already mentions 'note'.
 */
async function ensureNoteKind(db) {
  if (!await tableLacks(db, 'maintenance', "'note'")) return;

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
  // Columns listed out rather than SELECT *, so this keeps working when a
  // later migration has already added a column the new shape doesn't have.
  await db.prepare(
    `INSERT INTO maintenance_new
       (id, building_id, area_id, kind, detail, photo_key, status, day,
        reported_by, reported_at, resolved_by, resolved_at)
     SELECT id, building_id, area_id, kind, detail, photo_key, status, day,
        reported_by, reported_at, resolved_by, resolved_at FROM maintenance`,
  ).run();
  await db.prepare('DROP TABLE maintenance').run();
  await db.prepare('ALTER TABLE maintenance_new RENAME TO maintenance').run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance (status, id DESC)',
  ).run();
}

/**
 * Adds cleaning types to an `areas` table created before they existed.
 *
 * The unique key has to change from (building_id, name) to
 * (building_id, clean_type, name) - a building can now have a "Bathrooms" on
 * its Full Clean and a different "Bathrooms" on its Check - and SQLite can't
 * alter a constraint in place, so the table is rebuilt. Row ids are carried
 * across explicitly because tasks.area_id and maintenance.area_id point at
 * them; losing those would orphan every task in the park.
 *
 * Existing areas become 'both', so an installation that upgrades sees exactly
 * the checklist it had on both types until an admin splits them up. Nothing
 * silently disappears from a cleaner's list.
 */
async function ensureAreaCleanTypes(db) {
  if (!await tableLacks(db, 'areas', 'clean_type')) return;

  await db.prepare(`CREATE TABLE areas_new (
     id          INTEGER PRIMARY KEY,
     building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
     name        TEXT    NOT NULL,
     clean_type  TEXT    NOT NULL DEFAULT 'both'
                 CHECK (clean_type IN ('full', 'check', 'both')),
     sort_order  INTEGER NOT NULL DEFAULT 0,
     active      INTEGER NOT NULL DEFAULT 1,
     UNIQUE (building_id, clean_type, name)
   )`).run();
  await db.prepare(
    `INSERT INTO areas_new (id, building_id, name, clean_type, sort_order, active)
     SELECT id, building_id, name, 'both', sort_order, active FROM areas`,
  ).run();
  await db.prepare('DROP TABLE areas').run();
  await db.prepare('ALTER TABLE areas_new RENAME TO areas').run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_areas_building ON areas (building_id, active)',
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
 * Lost property was folded into the general 'note' kind rather than deleted -
 * existing reports stay visible, just relabelled. Gated by a settings flag
 * (rather than re-running the UPDATEs, which are unindexed table scans, on
 * every single request forever) so it only does the work once.
 */
async function ensureLostPropertyFolded(db) {
  if (await readSetting(db, 'lost_property_folded') === '1') return;
  await db.prepare(`UPDATE maintenance SET kind = 'note' WHERE kind = 'lost_property'`).run();
  await db.prepare(`UPDATE activity SET kind = 'note' WHERE kind = 'lost_property'`).run();
  await writeSetting(db, 'lost_property_folded', '1');
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

/**
 * Writes the checklist into the database.
 *
 * Anything removed from checklist.json is deactivated rather than deleted, so
 * the record of what was cleaned in the past never breaks.
 */
async function syncChecklist(db) {
  const buildings = plan();

  await db.batch(buildings.map((b) => db.prepare(
    `INSERT INTO buildings (name, grp, sort_order, active) VALUES (?, ?, ?, 1)
     ON CONFLICT(name) DO UPDATE SET
       grp = excluded.grp, sort_order = excluded.sort_order, active = 1`,
  ).bind(b.name, b.group, b.sort)));

  // Resolve ids in one pass so the task upserts don't need sub-selects.
  const { results: buildingRows } = await db.prepare('SELECT id, name FROM buildings').all();
  const buildingId = new Map(buildingRows.map((r) => [r.name, r.id]));

  const { results: areaRows } = await db.prepare(
    'SELECT id, building_id, name, clean_type FROM areas',
  ).all();

  // Match a planned area to an existing row by (building, type, name) first.
  // Falling back to matching on name alone is what keeps an upgrade from
  // duplicating every area: rows written before cleaning types existed are
  // all 'both', and the file now says 'full' or 'check' for most of them.
  // Without the fallback each of those would insert a second row and strand
  // the original's cleaning history.
  const exact = new Map();
  const byName = new Map();
  for (const r of areaRows) {
    exact.set(joinKey(r.building_id, r.clean_type, r.name), r);
    const key = joinKey(r.building_id, r.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  }

  const claimed = new Set();
  const inserts = [];
  const updates = [];
  const resolved = []; // [plannedArea, buildingId, existingId|null]

  for (const b of buildings) {
    const bid = buildingId.get(b.name);
    for (const a of b.areas) {
      let row = exact.get(joinKey(bid, a.cleanType, a.name));
      if (row && claimed.has(row.id)) row = null;
      if (!row) {
        row = (byName.get(joinKey(bid, a.name)) ?? []).find((r) => !claimed.has(r.id)) ?? null;
      }

      if (row) {
        claimed.add(row.id);
        updates.push(db.prepare(
          'UPDATE areas SET clean_type = ?, sort_order = ?, active = 1 WHERE id = ?',
        ).bind(a.cleanType, a.sort, row.id));
        resolved.push([a, bid, row.id]);
      } else {
        inserts.push(db.prepare(
          `INSERT INTO areas (building_id, name, clean_type, sort_order, active)
           VALUES (?, ?, ?, ?, 1)`,
        ).bind(bid, a.name, a.cleanType, a.sort));
        resolved.push([a, bid, null]);
      }
    }
  }

  if (updates.length) await db.batch(updates);
  if (inserts.length) await db.batch(inserts);

  // Re-read so the rows just inserted have ids.
  const { results: freshAreas } = await db.prepare(
    'SELECT id, building_id, name, clean_type FROM areas',
  ).all();
  const areaId = new Map(
    freshAreas.map((r) => [joinKey(r.building_id, r.clean_type, r.name), r.id]),
  );

  const taskStatements = [];
  const keep = new Set();
  for (const [area, bid] of resolved) {
    const aid = areaId.get(joinKey(bid, area.cleanType, area.name));
    if (!aid) continue;
    for (const t of area.tasks) {
      keep.add(joinKey(aid, t.item));
      taskStatements.push(db.prepare(
        `INSERT INTO tasks (area_id, item, description, photo_mode, sort_order, active)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(area_id, item) DO UPDATE SET
           description = excluded.description,
           photo_mode  = excluded.photo_mode,
           sort_order  = excluded.sort_order,
           active      = 1`,
      ).bind(aid, t.item, t.description, t.photoMode, t.sort));
    }
  }
  if (taskStatements.length) await db.batch(taskStatements);

  // Retire anything no longer in the checklist. A Set, not Array.includes -
  // the park runs to well over a thousand tasks and this used to be quadratic.
  const { results: allTasks } = await db.prepare(
    'SELECT id, area_id, item FROM tasks WHERE active = 1',
  ).all();
  const stale = allTasks.filter((t) => !keep.has(joinKey(t.area_id, t.item))).map((t) => t.id);
  if (stale.length) {
    await db.batch(stale.map((id) =>
      db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').bind(id)));
  }

  const liveAreas = new Set(resolved.map(([a, bid]) =>
    joinKey(bid, a.cleanType, a.name)));
  const retiredAreas = freshAreas
    .filter((r) => !liveAreas.has(joinKey(r.building_id, r.clean_type, r.name)))
    .map((r) => r.id);
  if (retiredAreas.length) {
    await db.batch(retiredAreas.map((id) =>
      db.prepare('UPDATE areas SET active = 0 WHERE id = ?').bind(id)));
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

  // Order matters around the two table rebuilds below, in opposite
  // directions, so neither can be reordered without breaking an upgrade:
  //
  //  - `areas.active` has to be added BEFORE the areas rebuild, because that
  //    rebuild copies the column across and would fail on a database old
  //    enough not to have it.
  //  - `maintenance.location` has to be added AFTER the maintenance rebuild,
  //    because that rebuild recreates the table from a fixed CREATE that
  //    doesn't mention it - adding it first meant it was silently dropped
  //    again, and every later report failed on a column that wasn't there.
  await ensureColumn(db, 'buildings', 'grp', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, 'areas', 'active', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn(db, 'users', 'availability', "TEXT NOT NULL DEFAULT '1111111'");
  await ensureColumn(db, 'tasks', 'photo_mode', "TEXT NOT NULL DEFAULT 'none'");
  await ensureColumn(db, 'schedule', 'clean_type', "TEXT NOT NULL DEFAULT 'full'");

  await ensureNoteKind(db);
  await ensureAreaCleanTypes(db);
  await ensureStatusCleanTypes(db);

  await ensureColumn(db, 'maintenance', 'location', "TEXT NOT NULL DEFAULT ''");
  await ensureLostPropertyFolded(db);

  // Once an admin edits the checklist inside the app, the app owns it and the
  // file stops being applied - otherwise the next deploy would quietly undo
  // their work. "Restore from file" in the admin screen hands control back.
  const source = await readSetting(db, 'checklist_source', 'file');

  // Only rewrite the checklist when its content actually changed.
  const version = await sha256Hex(JSON.stringify(plan()));
  if (source !== 'app' && await readSetting(db, 'checklist_version') !== version) {
    await syncChecklist(db);
    await writeSetting(db, 'checklist_version', version);
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
