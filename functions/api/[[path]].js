// Woodhouse Cleaning Tracker - API
// Single Cloudflare Pages Function handling every /api/* route.

import {
  ensureReady, applyChecklistFile, checklistVersion,
  contacts, CLEAN_TYPES, CLEAN_TYPE_LABELS, isCleanType, PHOTO_MODES,
} from './_setup.js';

// A cleaner signs in once on their own phone and shouldn't be asked again.
// Ninety days with a refresh on the way past means anyone who opens the app
// even occasionally never sees the PIN pad twice; a phone that stops being
// used stops working by itself. Losing one is handled by switching the person
// off under People, which currentUser honours on the very next request.
const TOKEN_TTL_DAYS = 90;
const REFRESH_AFTER_DAYS = 30;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_PHOTOS_PER_ITEM = 6;

/* ------------------------------------------------------------------ utils */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const fail = (status, message, extra = {}) => json({ error: message, ...extra }, status);

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const b64url = {
  encode(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

const enc = new TextEncoder();

// Set by ensureReady() before any handler runs - either the AUTH_SECRET set in
// the dashboard, or the one the app generated for itself on first run.
let signingKey = null;

async function hmac(_env, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// PINs are stored as a keyed hash, so a leaked database dump doesn't hand
// over working PINs.
/** What a signed-in client is allowed to know about a person. */
const pick = (u) => ({ id: u.id, name: u.name, role: u.role });

const firstName = (name) => String(name).split(/[\s(]/)[0];

const newToken = (env, uid) => sign(env, {
  uid,
  exp: Date.now() + TOKEN_TTL_DAYS * 86400_000,
});

async function hashPin(env, pin) {
  return b64url.encode(await hmac(env, `pin:${pin}`));
}

async function sign(env, payload) {
  const body = b64url.encode(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64url.encode(await hmac(env, body))}`;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verify(env, token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = b64url.encode(await hmac(env, body));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64url.decode(body)));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

/** Local calendar day (YYYY-MM-DD) for the camp's timezone, not UTC. */
function localDay(env, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.TIMEZONE || 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Calendar arithmetic on YYYY-MM-DD, done in UTC so DST can't shift a day. */
function addDays(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Monday = 0, matching the stored availability array. */
const weekdayIndex = (day) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function dayParam(url, env) {
  const d = url.searchParams.get('day');
  return isDay(d) ? d : localDay(env);
}

const now = () => new Date().toISOString();

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/* -------------------------------------------------------- cleaning types */

/**
 * Which of the two checklists is being asked for. Falls back to the Full
 * Clean, which is the safer default: showing someone too much to clean is
 * recoverable, showing them too little means a building goes out half done.
 */
const typeOf = (value, fallback = 'full') => (isCleanType(value) ? value : fallback);

/**
 * Entries on a given checklist: that type's own, plus the shared ones.
 *
 * Takes the parameter's position explicitly. SQLite numbers a bare `?` one
 * higher than the largest index used *so far in the statement text*, so a
 * fragment pasted into the middle of a query that already uses ?1/?2 can
 * silently claim an index that is already spoken for.
 */
const typeMatch = (n) => `t.clean_type IN (?${n}, 'both')`;

const typeLabel = (t) => CLEAN_TYPE_LABELS[t] ?? t;

/* ------------------------------------------------------- availability */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const OLD_AVAILABILITY = /^[01]{7}$/;

/** Minutes since midnight, or null if `t` isn't a HH:MM time. */
function toMinutes(t) {
  const m = TIME_RE.exec(String(t ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const MAX_IDEAL_HOURS = 80;

/**
 * Reads whatever is stored into { days, idealHours }.
 *
 * `days` is 7 entries, Monday first: null (doesn't work that day) or
 * { from, to, preferred } - a pair of HH:MM times, or two empty strings
 * meaning "works, no particular hours". `preferred` marks a day they would
 * *rather* work, which is a softer thing than being available and never
 * blocks anything; it only sorts and annotates.
 *
 * Understands every older format: the original '1111111' bitmap, the
 * 7-booleans JSON that replaced it, and the bare 7-entry array that came
 * before preferences existed. Anything unrecognised reads as fully available
 * rather than fully unavailable - nobody should drop off the roster because
 * their record predates a format change.
 */
function parseAvailability(raw) {
  const open = () => Array.from({ length: 7 }, () => ({ from: '', to: '', preferred: false }));
  const wrap = (days) => ({ days, idealHours: null });

  if (!raw) return wrap(open());

  if (OLD_AVAILABILITY.test(raw)) {
    return wrap([...raw].map((c) => (c === '1' ? { from: '', to: '', preferred: false } : null)));
  }

  const readDay = (entry) => {
    if (!entry) return null;
    if (entry === true) return { from: '', to: '', preferred: false };
    const from = TIME_RE.test(entry.from) ? entry.from : '';
    const to = TIME_RE.test(entry.to) ? entry.to : '';
    // A half-set range is meaningless; treat it as "no particular hours".
    return {
      from: from && to ? from : '',
      to: from && to ? to : '',
      preferred: Boolean(entry.preferred),
    };
  };

  try {
    const stored = JSON.parse(raw);
    const arr = Array.isArray(stored) ? stored : stored?.days;
    if (!Array.isArray(arr) || arr.length !== 7) return wrap(open());

    const hours = Number(stored?.idealHours);
    return {
      days: arr.map(readDay),
      idealHours: Number.isFinite(hours) && hours > 0 ? Math.min(hours, MAX_IDEAL_HOURS) : null,
    };
  } catch {
    return wrap(open());
  }
}

/** Just the seven days, for the many callers that only want those. */
const availabilityDays = (raw) => parseAvailability(raw).days;

/** Validates what the admin submitted and returns the string to store. */
function validateAvailability({ days, idealHours }) {
  if (!Array.isArray(days) || days.length !== 7) {
    throw new HttpError(400, 'Availability needs an entry for all seven days.');
  }

  const out = days.map((entry, i) => {
    if (!entry) return null;
    const from = clean(entry.from, 5);
    const to = clean(entry.to, 5);
    const preferred = Boolean(entry.preferred);
    if (!from && !to) return { from: '', to: '', preferred };
    if (!TIME_RE.test(from) || !TIME_RE.test(to)) {
      throw new HttpError(400, `${DAY_NAMES[i]}: times must look like 08:00.`);
    }
    if (toMinutes(to) <= toMinutes(from)) {
      throw new HttpError(400, `${DAY_NAMES[i]}: the finish time must be after the start time.`);
    }
    return { from, to, preferred };
  });

  let hours = null;
  if (idealHours !== undefined && idealHours !== null && String(idealHours).trim() !== '') {
    hours = Number(idealHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_IDEAL_HOURS) {
      throw new HttpError(400, `Ideal hours must be a number between 1 and ${MAX_IDEAL_HOURS}.`);
    }
    hours = Math.round(hours * 2) / 2; // half-hours are as fine as anyone needs
  }

  return JSON.stringify({ days: out, idealHours: hours });
}

const availabilityFor = (person, day) => availabilityDays(person.availability)[weekdayIndex(day)];

/* ----------------------------------------------------------- settings */

async function getSetting(env, key, fallback = null) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key).first();
  return row?.value ?? fallback;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(key, String(value)).run();
}

/**
 * Test mode: tap a name to sign in, no PIN. Convenient while setting the app
 * up, and a wide open door once real rosters are in it - so the UI shows a
 * banner on every screen while it is on.
 */
const quickSigninOn = async (env) => (await getSetting(env, 'quick_signin', '1')) === '1';

/** Editing the checklist in the app takes ownership away from the file. */
const ownChecklist = (env) => setSetting(env, 'checklist_source', 'app');

/* -------------------------------------------------------- push notifications */

const NTFY_SERVER = 'https://ntfy.sh';
const NTFY_TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

/** Raw publish call. Throws on any failure - callers decide what to do with that. */
async function publishNtfy(topic, payload) {
  const res = await fetch(NTFY_SERVER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic, ...payload }),
  });
  if (!res.ok) throw new Error(`ntfy.sh returned HTTP ${res.status}`);
}

/**
 * Sends a push notification via ntfy.sh - free, no account, works because
 * the topic name is unguessable rather than because of a login. Reads the
 * topic from the settings table (not an env var) so an admin can turn this
 * on from the People screen with no redeploy, matching every other toggle
 * in this app.
 *
 * Deliberately swallows every error: a maintenance report must still save
 * even if ntfy.sh is unreachable, mis-set, or the topic was never configured.
 */
async function sendNtfy(env, payload) {
  try {
    const topic = await getSetting(env, 'ntfy_topic', '');
    if (!topic) return;
    await publishNtfy(topic, payload);
  } catch (err) {
    console.error('ntfy', err);
  }
}

/* ------------------------------------------------------------------- auth */

async function currentUser(request, env) {
  const header = request.headers.get('authorization') || '';
  const claims = await verify(env, header.replace(/^Bearer\s+/i, ''));
  if (!claims) return null;
  // Re-read the user each request so deactivating someone takes effect
  // immediately rather than when their token happens to expire.
  const row = await env.DB.prepare(
    'SELECT id, name, role, active FROM users WHERE id = ?',
  ).bind(claims.uid).first();
  return row && row.active ? row : null;
}

function require(user, ...roles) {
  if (!user) throw new HttpError(401, 'Please sign in.');
  if (roles.length && !roles.includes(user.role)) {
    throw new HttpError(403, 'Your account does not have access to that.');
  }
  return user;
}

// Office and admin can read anything; cleaners read and write.
const canRead = (user) => require(user, 'cleaner', 'office', 'admin');
const canTick = (user) => require(user, 'cleaner', 'admin');

/* ----------------------------------------------------------- rate limiting */

async function loginGuard(env, ip) {
  const row = await env.DB.prepare('SELECT fails, until_ts FROM login_attempts WHERE ip = ?')
    .bind(ip).first();
  if (row && row.until_ts > Date.now()) {
    const secs = Math.ceil((row.until_ts - Date.now()) / 1000);
    throw new HttpError(429, `Too many wrong PINs. Try again in ${secs}s.`);
  }
  return row;
}

async function recordFail(env, ip, row) {
  const fails = (row?.fails ?? 0) + 1;
  // Everyone at the camp shares one office IP, so this has to tolerate genuine
  // fumbling: 8 free tries, then a lockout that tops out at 5 minutes and is
  // cleared entirely by the next successful sign-in from that IP.
  const until = fails > 8
    ? Date.now() + Math.min((fails - 8) * 60, 300) * 1000
    : 0;
  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, fails, until_ts) VALUES (?1, ?2, ?3)
     ON CONFLICT(ip) DO UPDATE SET fails = ?2, until_ts = ?3`,
  ).bind(ip, fails, until).run();
}

/* --------------------------------------------------------------- handlers */

async function logActivity(env, { day, buildingId, kind, detail, userName }) {
  await env.DB.prepare(
    `INSERT INTO activity (day, building_id, kind, detail, user_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(day, buildingId, kind, detail, userName, now()).run();
}

/**
 * Resolves a task to the building and area it belongs to, refusing anything
 * that has been hidden. Checking the area as well as the task matters: hiding
 * a whole area used to leave its items tickable by anyone holding a stale
 * page, which then counted towards a checklist they were no longer on.
 */
async function taskContext(env, taskId) {
  const row = await env.DB.prepare(
    `SELECT t.building_id AS building_id, t.clean_type AS clean_type,
            t.item AS item, t.photo_mode AS photo_mode
     FROM tasks t WHERE t.id = ? AND t.active = 1`,
  ).bind(taskId).first();
  if (!row) throw new HttpError(404, 'That item is no longer on the checklist.');
  return row;
}

/** Deletes photo objects from R2, ignoring anything already gone. */
async function dropPhotos(env, keys) {
  if (!env.PHOTOS || !keys.length) return;
  await Promise.all(keys.map((k) => env.PHOTOS.delete(k).catch(() => {})));
}

/**
 * What a cleaner can report from a building. There is one kind: something
 * needs fixing. "Lost property" and the general "note" are gone - they were a
 * second thing to choose between at the top of the form, and choosing wrong
 * meant a real fault sat in a list nobody was working through. Existing
 * reports of both were turned into maintenance reports rather than deleted
 * (see ensureReportKinds in _setup.js).
 *
 * `activity` is the verb key logActivity uses; `tag` and `priority` feed the
 * ntfy.sh push. Kept as a map so the shape doesn't have to change if a second
 * kind ever earns its place back.
 */
const REPORT_KINDS = {
  maintenance: { label: 'Maintenance', tag: 'wrench', priority: 4, activity: 'issue' },
};

/* ------------------------------------------------------------ roster help */

/**
 * Everything wrong with putting `userId` on a shift at this time - someone
 * marked unavailable, hours outside what they said they'd work, or a shift
 * they already have that overlaps. Returned rather than thrown: the office
 * routinely needs to roster over the top of all three (shift swaps, a big
 * changeover weekend), so this warns and lets them confirm.
 */
async function rosterConflicts(env, { userId, day, from, to, ignoreId = null }) {
  const conflicts = [];

  const person = await env.DB.prepare(
    'SELECT id, name, availability FROM users WHERE id = ? AND active = 1',
  ).bind(userId).first();
  if (!person) throw new HttpError(404, 'That person is not on the staff list.');

  const window = availabilityFor(person, day);
  const weekday = DAY_NAMES[weekdayIndex(day)];

  if (!window) {
    conflicts.push({
      code: 'unavailable',
      message: `${person.name} is marked unavailable on ${weekday}.`,
    });
  } else if (window.from && window.to) {
    const start = toMinutes(from);
    const end = toMinutes(to);
    if (start < toMinutes(window.from) || end > toMinutes(window.to)) {
      conflicts.push({
        code: 'outside',
        message: `${person.name} is only available ${window.from}–${window.to} on ${weekday}.`,
      });
    }
  }

  const { results: sameDay } = await env.DB.prepare(
    'SELECT id, start_time, end_time FROM roster WHERE user_id = ? AND day = ?',
  ).bind(userId, day).all();

  for (const shift of sameDay) {
    if (ignoreId && shift.id === ignoreId) continue;
    const overlaps = toMinutes(from) < toMinutes(shift.end_time)
      && toMinutes(to) > toMinutes(shift.start_time);
    if (overlaps) {
      conflicts.push({
        code: 'overlap',
        message: `${person.name} already has ${shift.start_time}–${shift.end_time} that day.`,
      });
    }
  }

  return { person, conflicts };
}

const routes = {
  /* --- session --- */

  'GET /config': async (_req, env) => {
    const bootstrapped = await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first();
    return json({
      needsBootstrap: !bootstrapped,
      quickSignin: await quickSigninOn(env),
      photos: Boolean(env.PHOTOS),
      rollupOnly: env.OFFICE_ROLLUP_ONLY === '1',
      officePhone: env.OFFICE_PHONE || contacts.office || '',
      maintenancePhone: env.MAINTENANCE_PHONE || contacts.maintenance || '',
      cleanTypes: CLEAN_TYPES.map((t) => ({ id: t, label: typeLabel(t) })),
      today: localDay(env),
    });
  },

  // Creates the first admin. Only works while the users table is empty, so it
  // closes itself the moment it is used.
  'POST /bootstrap': async (req, env) => {
    const already = await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first();
    if (already) throw new HttpError(403, 'Already set up. Sign in instead.');

    const { name, pin } = await req.json();
    const who = clean(name, 60);
    if (!who) throw new HttpError(400, 'Name is required.');
    if (!/^\d{4,8}$/.test(pin || '')) throw new HttpError(400, 'PIN must be 4-8 digits.');

    await env.DB.prepare(
      'INSERT INTO users (name, role, pin_hash, pin_length) VALUES (?, ?, ?, ?)',
    ).bind(who, 'admin', await hashPin(env, pin), pin.length).run();
    return json({ ok: true });
  },

  // Only reachable while test mode is on; it is what fills the tap-to-sign-in list.
  /**
   * The names on the sign-in screen. Open, because picking your name is the
   * first half of signing in - the PIN is still what proves it is you.
   *
   * `pinLength` is here so the pad can draw the right number of slots and
   * submit on the last digit instead of making everyone reach for a button.
   * It narrows a guess from "four to eight digits" to one length, which the
   * eight-tries-then-lockout guard on POST /login already covers.
   */
  'GET /people': async (_req, env) => {
    const { results } = await env.DB.prepare(
      'SELECT id, name, role, pin_length AS pinLength FROM users WHERE active = 1 ORDER BY name',
    ).all();
    return json({ people: results });
  },

  'POST /login': async (req, env) => {
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    const guard = await loginGuard(env, ip);

    const { pin, userId } = await req.json();
    const hasPin = /^\d{4,8}$/.test(pin || '');
    let user = null;
    let named = null;

    if (userId != null) {
      named = await env.DB.prepare(
        'SELECT id, name, role, pin_hash FROM users WHERE id = ? AND active = 1',
      ).bind(Number(userId)).first();

      // Name plus PIN: the PIN is checked against the person who was picked,
      // so a mistype can never sign somebody in as a colleague - which is the
      // one failure that would quietly put the wrong name on a day's work.
      if (named && hasPin) {
        if (timingSafeEqual(named.pin_hash, await hashPin(env, pin))) user = named;
      } else if (named && await quickSigninOn(env)) {
        user = named;
      } else if (!named) {
        throw new HttpError(401, 'That person is no longer on the list.');
      } else {
        throw new HttpError(400, 'Enter your PIN.');
      }
    } else if (hasPin) {
      // No name given: the old PIN-is-the-identity path, kept so a phone
      // running a cached copy of the app can still sign in.
      user = await env.DB.prepare(
        'SELECT id, name, role FROM users WHERE pin_hash = ? AND active = 1',
      ).bind(await hashPin(env, pin)).first();
    }

    if (!user) {
      await recordFail(env, ip, guard);
      throw new HttpError(401, named
        ? `That is not ${firstName(named.name)}'s PIN.`
        : 'PIN not recognised.');
    }

    await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
    return json({ token: await newToken(env, user.id), user: pick(user) });
  },

  /**
   * A fresh token for a session already in good standing, so a phone in
   * regular use never reaches its expiry and never asks for a PIN again.
   */
  'POST /session/refresh': async (_req, env, { user }) => {
    require(user);
    return json({ token: await newToken(env, user.id), user: pick(user) });
  },

  'GET /me': async (req, env, { user }) => json({ user: require(user) }),

  /* --- office rollup --- */

  'GET /overview': async (req, env, { user, url }) => {
    canRead(user);
    const day = dayParam(url, env);

    const [buildings, totals, progress, crew, planned, statuses, lastDone, issues] =
      await Promise.all([
        env.DB.prepare(
          `SELECT id, name, grp FROM buildings WHERE active = 1 ORDER BY sort_order, name`,
        ).all(),
        // Entry counts per building per checklist, so the rows can say how big
        // a Full Clean is versus a Check without a query each.
        env.DB.prepare(
          `SELECT t.building_id, t.clean_type, COUNT(*) AS n
           FROM tasks t WHERE t.active = 1
           GROUP BY t.building_id, t.clean_type`,
        ).all(),
        env.DB.prepare(
          `SELECT t.building_id, t.clean_type, COUNT(*) AS n
           FROM task_log l
           JOIN tasks t ON t.id = l.task_id AND t.active = 1
           WHERE l.day = ?1 AND l.done = 1
           GROUP BY t.building_id, t.clean_type`,
        ).bind(day).all(),
        env.DB.prepare(
          `SELECT t.building_id AS building_id, l.user_name AS name, MAX(l.updated_at) AS last_at
           FROM task_log l
           JOIN tasks t ON t.id = l.task_id
           WHERE l.day = ?1 AND l.user_name IS NOT NULL
           GROUP BY t.building_id, l.user_name
           ORDER BY last_at DESC`,
        ).bind(day).all(),
        env.DB.prepare(
          `SELECT id, building_id, clean_type, priority, note FROM schedule WHERE day = ?`,
        ).bind(day).all(),
        env.DB.prepare(
          `SELECT building_id, clean_type, completed_at, completed_by
           FROM building_status WHERE day = ?`,
        ).bind(day).all(),
        env.DB.prepare(
          `SELECT building_id, MAX(day) AS last_day FROM building_status
           WHERE day <= ? GROUP BY building_id`,
        ).bind(day).all(),
        env.DB.prepare(
          `SELECT building_id, COUNT(*) AS n FROM maintenance
           WHERE status = 'open' GROUP BY building_id`,
        ).all(),
      ]);

    // Sum a building's own items for this type plus the shared 'both' ones.
    const perType = (rows, id) => {
      const pick = (t) => rows.results.find((r) => r.building_id === id && r.clean_type === t)?.n ?? 0;
      const shared = pick('both');
      return { full: pick('full') + shared, check: pick('check') + shared };
    };

    const byBuilding = new Map();
    for (const c of crew.results) {
      if (!byBuilding.has(c.building_id)) byBuilding.set(c.building_id, []);
      byBuilding.get(c.building_id).push(c.name);
    }

    const lastAt = new Map();
    for (const c of crew.results) {
      const prev = lastAt.get(c.building_id);
      if (!prev || c.last_at > prev) lastAt.set(c.building_id, c.last_at);
    }

    const planFor = new Map(planned.results.map((p) => [p.building_id, p]));
    const lastFor = new Map(lastDone.results.map((r) => [r.building_id, r.last_day]));
    const issuesFor = new Map(issues.results.map((r) => [r.building_id, r.n]));

    const enriched = buildings.results.map((b) => {
      const plan = planFor.get(b.id);
      const cleanType = typeOf(plan?.clean_type);
      const totalsFor = perType(totals, b.id);
      const doneFor = perType(progress, b.id);
      const signedOff = statuses.results.filter((s) => s.building_id === b.id);
      const status = signedOff.find((s) => s.clean_type === cleanType);

      return {
        id: b.id,
        name: b.name,
        grp: b.grp,
        cleanType,
        total: totalsFor[cleanType],
        done: doneFor[cleanType],
        sizes: totalsFor,
        last_at: lastAt.get(b.id) ?? null,
        crew: byBuilding.get(b.id) ?? [],
        open_issues: issuesFor.get(b.id) ?? 0,
        completed_at: status?.completed_at ?? null,
        completed_by: status?.completed_by ?? null,
        // Both sign-offs, so the office can see a building was checked this
        // morning even while its Full Clean is still outstanding.
        signedOff: signedOff.map((s) => ({
          cleanType: s.clean_type, at: s.completed_at, by: s.completed_by,
        })),
        scheduled: Boolean(plan),
        priority: plan?.priority ?? null,
        note: plan?.note ?? null,
        lastCleaned: lastFor.get(b.id) ?? null,
      };
    });

    // Scheduled buildings first in priority order, then everything else.
    enriched.sort((x, y) => {
      if (x.scheduled !== y.scheduled) return x.scheduled ? -1 : 1;
      if (x.scheduled && x.priority !== y.priority) return x.priority - y.priority;
      return 0;
    });

    return json({ day, buildings: enriched });
  },

  /* --- the weekly cleaning plan --- */

  // The day-grid: every building crossed with a range of days.
  'GET /schedule': async (_req, env, { user, url }) => {
    canRead(user);
    const from = isDay(url.searchParams.get('from'))
      ? url.searchParams.get('from') : localDay(env);
    const span = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 31);
    const days = Array.from({ length: span }, (_, i) => addDays(from, i));
    const to = days[days.length - 1];

    const [buildings, rows, totals, progress, completions] = await Promise.all([
      env.DB.prepare(
        'SELECT id, name, grp FROM buildings WHERE active = 1 ORDER BY sort_order, name',
      ).all(),
      env.DB.prepare(
        `SELECT id, building_id, day, clean_type, priority, note
         FROM schedule WHERE day BETWEEN ? AND ?`,
      ).bind(from, to).all(),
      env.DB.prepare(
        `SELECT t.building_id, t.clean_type, COUNT(*) AS n FROM tasks t
         WHERE t.active = 1 GROUP BY t.building_id, t.clean_type`,
      ).all(),
      env.DB.prepare(
        `SELECT t.building_id, t.clean_type, l.day, COUNT(*) AS n
         FROM task_log l
         JOIN tasks t ON t.id = l.task_id AND t.active = 1
         WHERE l.done = 1 AND l.day BETWEEN ? AND ?
         GROUP BY t.building_id, t.clean_type, l.day`,
      ).bind(from, to).all(),
      env.DB.prepare(
        `SELECT building_id, day, clean_type, completed_at, completed_by
         FROM building_status WHERE day BETWEEN ? AND ?`,
      ).bind(from, to).all(),
    ]);

    const sizeOf = (bid) => {
      const pick = (t) =>
        totals.results.find((r) => r.building_id === bid && r.clean_type === t)?.n ?? 0;
      const shared = pick('both');
      return { full: pick('full') + shared, check: pick('check') + shared };
    };

    const cells = {};
    const put = (bid, day, patch) => {
      const key = `${bid}:${day}`;
      cells[key] = { ...(cells[key] ?? {}), ...patch };
    };
    for (const r of rows.results) {
      put(r.building_id, r.day, {
        cleanType: typeOf(r.clean_type),
        priority: r.priority,
        note: r.note,
      });
    }
    for (const p of progress.results) {
      const key = `${p.building_id}:${p.day}`;
      const soFar = cells[key]?.doneByType ?? {};
      put(p.building_id, p.day, { doneByType: { ...soFar, [p.clean_type]: p.n } });
    }
    for (const c of completions.results) {
      put(c.building_id, c.day, {
        completedAt: c.completed_at,
        completedBy: c.completed_by,
        completedType: c.clean_type,
      });
    }

    // Resolve each cell's "done" against whichever checklist it is on.
    for (const [key, cell] of Object.entries(cells)) {
      const type = cell.cleanType ?? cell.completedType ?? 'full';
      const by = cell.doneByType ?? {};
      cell.done = (by[type] ?? 0) + (by.both ?? 0);
      delete cell.doneByType;
      cells[key] = cell;
    }

    return json({
      from,
      days,
      today: localDay(env),
      buildings: buildings.results.map((b) => ({ ...b, sizes: sizeOf(b.id) })),
      cells,
      canEdit: user.role !== 'cleaner',
    });
  },

  'POST /schedule': async (req, env, { user }) => {
    require(user, 'office', 'admin');
    const { buildingId, day: rawDay, priority, note, cleanType } = await req.json();
    const day = isDay(rawDay) ? rawDay : localDay(env);
    const id = Number(buildingId);
    const type = typeOf(cleanType);

    const building = await env.DB.prepare(
      'SELECT name FROM buildings WHERE id = ? AND active = 1',
    ).bind(id).first();
    if (!building) throw new HttpError(404, 'Building not found.');

    await env.DB.prepare(
      `INSERT INTO schedule (building_id, day, clean_type, priority, note, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(building_id, day) DO UPDATE SET
         clean_type = excluded.clean_type,
         priority = excluded.priority,
         note = excluded.note`,
    ).bind(
      id, day, type, Math.min(Math.max(Number(priority) || 1, 1), 99),
      clean(note, 200) || null, user.name, now(),
    ).run();

    await logActivity(env, {
      day, buildingId: id, kind: 'scheduled',
      detail: typeLabel(type),
      userName: user.name,
    });

    return json({ ok: true });
  },

  'POST /schedule/clear': async (req, env, { user }) => {
    require(user, 'office', 'admin');
    const { buildingId, day: rawDay, clearProgress } = await req.json();
    const day = isDay(rawDay) ? rawDay : localDay(env);
    const id = Number(buildingId);

    const row = await env.DB.prepare(
      'SELECT id, clean_type FROM schedule WHERE building_id = ? AND day = ?',
    ).bind(id, day).first();
    const type = typeOf(row?.clean_type);

    if (row) await env.DB.prepare('DELETE FROM schedule WHERE id = ?').bind(row.id).run();

    // Optional, because un-planning a day and erasing the work someone already
    // did that day are two different intentions. Scoped to the checklist that
    // was actually planned, so wiping a Check can't erase a Full Clean.
    if (clearProgress) {
      const { results: photos } = await env.DB.prepare(
        `SELECT p.photo_key FROM task_photos p
         JOIN tasks t ON t.id = p.task_id
         WHERE p.day = ?1 AND t.building_id = ?2 AND ${typeMatch(3)}`,
      ).bind(day, id, type).all();

      await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM task_photos WHERE day = ?1 AND task_id IN (
             SELECT t.id FROM tasks t WHERE t.building_id = ?2 AND ${typeMatch(3)})`,
        ).bind(day, id, type),
        env.DB.prepare(
          `DELETE FROM task_log WHERE day = ?1 AND task_id IN (
             SELECT t.id FROM tasks t WHERE t.building_id = ?2 AND ${typeMatch(3)})`,
        ).bind(day, id, type),
        env.DB.prepare(
          'DELETE FROM building_status WHERE building_id = ? AND day = ? AND clean_type = ?',
        ).bind(id, day, type),
        env.DB.prepare('DELETE FROM activity WHERE building_id = ? AND day = ?')
          .bind(id, day),
      ]);

      await dropPhotos(env, photos.map((p) => p.photo_key));
    }

    return json({ ok: true });
  },

  'GET /activity': async (req, env, { user, url }) => {
    // Office-side reporting: cleaners see attribution on the checklist itself.
    require(user, 'office', 'admin');
    const day = dayParam(url, env);
    const { results } = await env.DB.prepare(
      `SELECT ac.id, ac.kind, ac.detail, ac.user_name, ac.created_at, b.name AS building
       FROM activity ac JOIN buildings b ON b.id = ac.building_id
       WHERE ac.day = ? ORDER BY ac.id DESC LIMIT 200`,
    ).bind(day).all();
    return json({ day, activity: results });
  },

  /* --- a single building's checklist --- */

  'GET /building': async (req, env, { user, url }) => {
    canRead(user);
    if (user.role === 'office' && env.OFFICE_ROLLUP_ONLY === '1') {
      throw new HttpError(403, 'Individual checklists are visible to cleaners only.');
    }

    const id = Number(url.searchParams.get('id'));
    const day = dayParam(url, env);
    const building = await env.DB.prepare(
      'SELECT id, name FROM buildings WHERE id = ? AND active = 1',
    ).bind(id).first();
    if (!building) throw new HttpError(404, 'Building not found.');

    // What was planned decides the default, so the common path is: open the
    // building, get the checklist the office asked for, no choice to make.
    const plan = await env.DB.prepare(
      'SELECT clean_type, note, priority FROM schedule WHERE building_id = ? AND day = ?',
    ).bind(id, day).first();
    const requested = url.searchParams.get('type');
    const cleanType = typeOf(requested, typeOf(plan?.clean_type));

    const { results: sizes } = await env.DB.prepare(
      `SELECT t.clean_type, COUNT(*) AS n FROM tasks t
       WHERE t.building_id = ? AND t.active = 1
       GROUP BY t.clean_type`,
    ).bind(id).all();
    const sizeOf = (t) => (sizes.find((r) => r.clean_type === t)?.n ?? 0)
      + (sizes.find((r) => r.clean_type === 'both')?.n ?? 0);

    const { results: rows } = await env.DB.prepare(
      `SELECT t.id AS task_id, t.item, t.description, t.photo_mode,
              l.done, l.user_name, l.updated_at
       FROM tasks t
       LEFT JOIN task_log l ON l.task_id = t.id AND l.day = ?2
       WHERE t.building_id = ?1 AND t.active = 1 AND ${typeMatch(3)}
       ORDER BY t.sort_order, t.id`,
    ).bind(id, day, cleanType).all();

    const { results: photos } = await env.DB.prepare(
      `SELECT p.id, p.task_id, p.photo_key, p.user_name, p.created_at
       FROM task_photos p
       JOIN tasks t ON t.id = p.task_id
       WHERE t.building_id = ?1 AND p.day = ?2 AND ${typeMatch(3)}
       ORDER BY p.id`,
    ).bind(id, day, cleanType).all();

    const photosFor = new Map();
    for (const p of photos) {
      if (!photosFor.has(p.task_id)) photosFor.set(p.task_id, []);
      photosFor.get(p.task_id).push({
        id: p.id, key: p.photo_key, by: p.user_name, at: p.created_at,
      });
    }

    const items = rows.map((r) => ({
      id: r.task_id,
      item: r.item,
      description: r.description,
      photoMode: PHOTO_MODES.includes(r.photo_mode) ? r.photo_mode : 'none',
      photos: photosFor.get(r.task_id) ?? [],
      done: Boolean(r.done),
      by: r.user_name,
      at: r.updated_at,
    }));

    const status = await env.DB.prepare(
      `SELECT completed_at, completed_by FROM building_status
       WHERE building_id = ? AND day = ? AND clean_type = ?`,
    ).bind(id, day, cleanType).first();

    const { results: issues } = await env.DB.prepare(
      `SELECT id, location, detail, photo_key, status, reported_by, reported_at
       FROM maintenance WHERE building_id = ? AND status = 'open'
       ORDER BY id DESC`,
    ).bind(id).all();

    return json({
      day,
      building,
      cleanType,
      cleanTypeLabel: typeLabel(cleanType),
      sizes: { full: sizeOf('full'), check: sizeOf('check') },
      scheduledType: plan ? typeOf(plan.clean_type) : null,
      scheduleNote: plan?.note ?? null,
      items,
      completed: status ?? null,
      issues,
      readOnly: user.role === 'office',
    });
  },

  'POST /task': async (req, env, { user }) => {
    canTick(user);
    const { taskId, done, day: rawDay } = await req.json();
    const day = isDay(rawDay) ? rawDay : localDay(env);
    const task = await taskContext(env, Number(taskId));
    const ts = now();

    await env.DB.prepare(
      `INSERT INTO task_log (task_id, day, done, user_id, user_name, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(task_id, day) DO UPDATE SET
         done = excluded.done, user_id = excluded.user_id,
         user_name = excluded.user_name, updated_at = excluded.updated_at`,
    ).bind(Number(taskId), day, done ? 1 : 0, user.id, user.name, ts).run();

    await logActivity(env, {
      day,
      buildingId: task.building_id,
      kind: done ? 'done' : 'undone',
      detail: task.item,
      userName: user.name,
    });

    return json({ ok: true, at: ts, by: user.name });
  },

  /* --- photos against an individual checklist item --- */

  /**
   * Raw image body rather than multipart: the browser has already resized the
   * picture to a JPEG blob, and parsing multipart at the edge to recover the
   * same bytes would only add latency on the mobile connection this runs on.
   */
  'POST /task/photo': async (req, env, { user, url }) => {
    canTick(user);
    if (!env.PHOTOS) throw new HttpError(501, 'Photo uploads are not set up on this site.');

    const taskId = Number(url.searchParams.get('taskId'));
    const day = dayParam(url, env);
    const task = await taskContext(env, taskId);
    if (task.photo_mode === 'none') {
      throw new HttpError(400, 'This item does not take photos.');
    }

    const existing = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM task_photos WHERE task_id = ? AND day = ?',
    ).bind(taskId, day).first();
    if (existing.n >= MAX_PHOTOS_PER_ITEM) {
      throw new HttpError(400, `Up to ${MAX_PHOTOS_PER_ITEM} photos per item.`);
    }

    const type = req.headers.get('content-type') || '';
    if (!/^image\/(jpeg|png|webp)$/.test(type)) {
      throw new HttpError(400, 'Photo must be a JPEG, PNG or WebP image.');
    }
    // Refuse on the declared length before pulling megabytes into memory.
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo is too large.');

    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo is too large.');

    const key = `task/${day}/${crypto.randomUUID()}`;
    const ts = now();
    await env.PHOTOS.put(key, body, { httpMetadata: { contentType: type } });

    const res = await env.DB.prepare(
      `INSERT INTO task_photos (task_id, day, photo_key, bytes, user_id, user_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(taskId, day, key, body.byteLength, user.id, user.name, ts).run();

    await logActivity(env, {
      day, buildingId: task.building_id, kind: 'photo',
      detail: task.item, userName: user.name,
    });

    return json({
      ok: true,
      photo: { id: res.meta.last_row_id, key, by: user.name, at: ts },
    });
  },

  'POST /task/photo/delete': async (req, env, { user }) => {
    canTick(user);
    const id = Number((await req.json()).id);
    const row = await env.DB.prepare(
      `SELECT p.id, p.photo_key, p.day, t.item, t.building_id
       FROM task_photos p JOIN tasks t ON t.id = p.task_id WHERE p.id = ?`,
    ).bind(id).first();
    if (!row) throw new HttpError(404, 'That photo has already gone.');

    await env.DB.prepare('DELETE FROM task_photos WHERE id = ?').bind(id).run();
    await dropPhotos(env, [row.photo_key]);
    await logActivity(env, {
      day: row.day,
      buildingId: row.building_id,
      kind: 'photo_removed',
      detail: row.item,
      userName: user.name,
    });
    return json({ ok: true });
  },

  'POST /building/complete': async (req, env, { user }) => {
    canTick(user);
    const { buildingId, day: rawDay, undo, cleanType, override } = await req.json();
    const day = isDay(rawDay) ? rawDay : localDay(env);
    const id = Number(buildingId);
    const type = typeOf(cleanType);

    if (undo) {
      await env.DB.prepare(
        'DELETE FROM building_status WHERE building_id = ? AND day = ? AND clean_type = ?',
      ).bind(id, day, type).run();
      await logActivity(env, {
        day, buildingId: id, kind: 'reopened',
        detail: `${typeLabel(type)} reopened`, userName: user.name,
      });
      return json({ ok: true, completed: null });
    }

    // Items the admin marked "photo required" that have no photo today. Not a
    // hard block - a dead camera phone shouldn't strand a finished building -
    // but the office sees it was signed off short.
    const { results: missing } = await env.DB.prepare(
      `SELECT t.id, t.item FROM tasks t
       WHERE t.building_id = ?1 AND t.active = 1
         AND t.photo_mode = 'required' AND ${typeMatch(3)}
         AND NOT EXISTS (
           SELECT 1 FROM task_photos p WHERE p.task_id = t.id AND p.day = ?2)
       ORDER BY t.sort_order`,
    ).bind(id, day, type).all();

    if (missing.length && !override) {
      throw new HttpError(409, `${missing.length} item${missing.length === 1 ? '' : 's'} still `
        + 'needs a photo.', { missingPhotos: missing });
    }

    const ts = now();
    await env.DB.prepare(
      `INSERT INTO building_status (building_id, day, clean_type, completed_at, completed_by)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(building_id, day, clean_type) DO UPDATE SET
         completed_at = excluded.completed_at, completed_by = excluded.completed_by`,
    ).bind(id, day, type, ts, user.name).run();

    await logActivity(env, {
      day, buildingId: id, kind: 'completed',
      detail: missing.length
        ? `${typeLabel(type)} complete — ${missing.length} photo${
          missing.length === 1 ? '' : 's'} missing`
        : `${typeLabel(type)} complete`,
      userName: user.name,
    });
    return json({ ok: true, completed: { completed_at: ts, completed_by: user.name } });
  },

  /* --- maintenance reports --- */

  'GET /maintenance': async (req, env, { user, url }) => {
    canRead(user);
    const status = url.searchParams.get('status') === 'resolved' ? 'resolved' : 'open';
    const { results } = await env.DB.prepare(
      `SELECT m.id, m.kind, m.detail, m.photo_key, m.status, m.day, m.location,
              m.reported_by, m.reported_at, m.resolved_by, m.resolved_at,
              b.name AS building
       FROM maintenance m
       JOIN buildings b ON b.id = m.building_id
       WHERE m.status = ? ORDER BY m.id DESC LIMIT 200`,
    ).bind(status).all();
    return json({ items: results });
  },

  'POST /maintenance': async (req, env, { user, url, waitUntil }) => {
    require(user, 'cleaner', 'office', 'admin');
    const { buildingId, location, detail, kind, photoKey } = await req.json();
    const text = clean(detail, 1000);
    if (!text) throw new HttpError(400, 'Please add some detail.');

    const type = REPORT_KINDS[kind] ? kind : 'maintenance';
    const info = REPORT_KINDS[type];
    const day = localDay(env);
    const id = Number(buildingId);
    // Free text, not a dropdown: "the tap by the back door" is the answer
    // people actually have, and no list of places contains it.
    const where = clean(location, 120);

    const building = await env.DB.prepare(
      'SELECT name FROM buildings WHERE id = ? AND active = 1',
    ).bind(id).first();
    if (!building) throw new HttpError(404, 'Building not found.');

    const res = await env.DB.prepare(
      `INSERT INTO maintenance
         (building_id, location, kind, detail, photo_key, day, reported_by, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, where, type, text, clean(photoKey, 200) || null, day, user.name, now()).run();

    await logActivity(env, {
      day, buildingId: id, kind: info.activity,
      detail: where ? `${where} — ${text}` : text,
      userName: user.name,
    });

    // Fires after the response is already on its way back, so a slow or dead
    // ntfy.sh never makes a cleaner wait to submit a report.
    waitUntil(sendNtfy(env, {
      title: `${info.label} — ${building.name}${where ? ` (${where})` : ''}`,
      message: `${text}\n\nReported by ${user.name}`,
      priority: info.priority,
      tags: [info.tag],
      click: `${url.origin}/#/issues`,
    }));

    return json({ ok: true, id: res.meta.last_row_id });
  },

  'POST /maintenance/resolve': async (req, env, { user }) => {
    require(user, 'office', 'admin');
    const { id, reopen } = await req.json();
    const res = reopen
      ? await env.DB.prepare(
        `UPDATE maintenance SET status = 'open', resolved_by = NULL, resolved_at = NULL
         WHERE id = ?`,
      ).bind(Number(id)).run()
      : await env.DB.prepare(
        `UPDATE maintenance SET status = 'resolved', resolved_by = ?, resolved_at = ?
         WHERE id = ?`,
      ).bind(user.name, now(), Number(id)).run();

    if (!res.meta.changes) throw new HttpError(404, 'That report no longer exists.');
    return json({ ok: true });
  },

  /* --- photos on reports (only when an R2 bucket is bound) --- */

  'POST /photo': async (req, env, { user }) => {
    require(user, 'cleaner', 'office', 'admin');
    if (!env.PHOTOS) throw new HttpError(501, 'Photo uploads are not configured.');

    const type = req.headers.get('content-type') || '';
    if (!/^image\/(jpeg|png|webp)$/.test(type)) {
      throw new HttpError(400, 'Photo must be a JPEG, PNG or WebP image.');
    }
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo is too large.');

    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo is too large.');

    const key = `${localDay(env)}/${crypto.randomUUID()}`;
    await env.PHOTOS.put(key, body, { httpMetadata: { contentType: type } });
    return json({ key });
  },

  'GET /photo': async (req, env, { user, url }) => {
    canRead(user);
    if (!env.PHOTOS) throw new HttpError(404, 'Not found.');
    const object = await env.PHOTOS.get(url.searchParams.get('key') || '');
    if (!object) throw new HttpError(404, 'Photo not found.');
    return new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
        'cache-control': 'private, max-age=86400',
      },
    });
  },

  /* --- admin: people --- */

  'GET /users': async (req, env, { user }) => {
    require(user, 'admin');
    const { results } = await env.DB.prepare(
      `SELECT id, name, role, active, availability, created_at
       FROM users ORDER BY active DESC, name`,
    ).all();
    return json({
      users: results.map((u) => {
        const { days, idealHours } = parseAvailability(u.availability);
        return { ...u, availability: days, idealHours };
      }),
    });
  },

  'POST /users': async (req, env, { user }) => {
    require(user, 'admin');
    const { id, name, role, pin, active } = await req.json();
    const who = clean(name, 60);
    if (!who) throw new HttpError(400, 'Name is required.');
    if (!['cleaner', 'office', 'admin'].includes(role)) {
      throw new HttpError(400, 'Pick a valid role.');
    }
    if (pin && !/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'PIN must be 4-8 digits.');

    // The PIN *is* the identity here, so two people sharing one would sign in
    // as whichever row the database happened to return. Caught up front with
    // a sentence someone can act on, rather than as a unique-index 500.
    if (pin) {
      const clash = await env.DB.prepare(
        'SELECT id FROM users WHERE pin_hash = ? AND id IS NOT ?',
      ).bind(await hashPin(env, pin), id ? Number(id) : null).first();
      if (clash) throw new HttpError(400, 'Somebody already uses that PIN. Choose another.');
    }

    if (id) {
      // Don't let the last admin disable or demote themselves - that would
      // lock everyone out of the People screen with no way back in.
      if (role !== 'admin' || !active) {
        const others = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM users
           WHERE role = 'admin' AND active = 1 AND id != ?`,
        ).bind(Number(id)).first();
        if (!others.n) {
          throw new HttpError(400, 'This is the only admin - promote someone else first.');
        }
      }

      await env.DB.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?')
        .bind(who, role, active ? 1 : 0, Number(id)).run();
      if (pin) {
        await env.DB.prepare('UPDATE users SET pin_hash = ?, pin_length = ? WHERE id = ?')
          .bind(await hashPin(env, pin), pin.length, Number(id)).run();
      }
      // A renamed person should read correctly on next week's roster too.
      await env.DB.prepare('UPDATE roster SET user_name = ? WHERE user_id = ?')
        .bind(who, Number(id)).run();
      return json({ ok: true });
    }

    if (!/^\d{4,8}$/.test(pin || '')) throw new HttpError(400, 'PIN must be 4-8 digits.');
    await env.DB.prepare(
      'INSERT INTO users (name, role, pin_hash, pin_length) VALUES (?, ?, ?, ?)',
    ).bind(who, role, await hashPin(env, pin), pin.length).run();
    return json({ ok: true });
  },

  /**
   * Removes a person outright. Their past work stays readable because
   * task_log and activity keep the name they had at the time.
   */
  'POST /users/delete': async (req, env, { user }) => {
    require(user, 'admin');
    const id = Number((await req.json()).id);

    if (id === user.id) throw new HttpError(400, 'You cannot delete your own account.');

    const target = await env.DB.prepare('SELECT id, name, role, active FROM users WHERE id = ?')
      .bind(id).first();
    if (!target) throw new HttpError(404, 'That person no longer exists.');

    if (target.role === 'admin' && target.active) {
      const others = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?`,
      ).bind(id).first();
      if (!others.n) throw new HttpError(400, 'That is the only admin left.');
    }

    const shifts = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM roster WHERE user_id = ? AND day >= ?',
    ).bind(id, localDay(env)).first();

    await env.DB.batch([
      env.DB.prepare('DELETE FROM roster WHERE user_id = ?').bind(id),
      // Keep the history, drop the link.
      env.DB.prepare('UPDATE task_log SET user_id = NULL WHERE user_id = ?').bind(id),
      env.DB.prepare('UPDATE task_photos SET user_id = NULL WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
    ]);

    return json({ ok: true, name: target.name, removedShifts: shifts.n ?? 0 });
  },

  /* --- availability: the days and hours each person works --- */

  'POST /availability': async (req, env, { user }) => {
    // Cleaners' hours are managed by the office/admin, not by cleaners
    // themselves - so this always requires an elevated role, self or not.
    require(user, 'office', 'admin');
    const { userId, days, idealHours } = await req.json();
    const target = userId ? Number(userId) : user.id;
    const stored = validateAvailability({ days, idealHours });

    const res = await env.DB.prepare('UPDATE users SET availability = ? WHERE id = ?')
      .bind(stored, target).run();
    if (!res.meta.changes) throw new HttpError(404, 'That person no longer exists.');
    return json({ ok: true, ...parseAvailability(stored) });
  },

  /**
   * Everyone's week in one payload - the whole point of the availability
   * screen is not having to open each person in turn. Shift counts come along
   * so the same table can show who is already carrying the week.
   */
  'GET /availability': async (_req, env, { user, url }) => {
    require(user, 'office', 'admin');
    const from = isDay(url.searchParams.get('from'))
      ? url.searchParams.get('from') : localDay(env);
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));

    const [people, shifts] = await Promise.all([
      env.DB.prepare(
        `SELECT id, name, role, availability FROM users
         WHERE active = 1 ORDER BY name`,
      ).all(),
      env.DB.prepare(
        `SELECT user_id, day, start_time, end_time FROM roster
         WHERE day BETWEEN ? AND ?`,
      ).bind(days[0], days[6]).all(),
    ]);

    const counts = new Map();
    const minutes = new Map();
    for (const r of shifts.results) {
      const key = `${r.user_id}:${r.day}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const span = toMinutes(r.end_time) - toMinutes(r.start_time);
      minutes.set(r.user_id, (minutes.get(r.user_id) ?? 0) + (span > 0 ? span : 0));
    }

    return json({
      from,
      days,
      today: localDay(env),
      staff: people.results.map((p) => {
        const { days: avail, idealHours } = parseAvailability(p.availability);
        return {
          id: p.id,
          name: p.name,
          role: p.role,
          availability: avail,
          idealHours,
          rostered: days.map((d) => counts.get(`${p.id}:${d}`) ?? 0),
          rosteredHours: Math.round(((minutes.get(p.id) ?? 0) / 60) * 10) / 10,
        };
      }),
    });
  },

  /* --- the staff roster --- */

  'GET /roster': async (_req, env, { user, url }) => {
    canRead(user);
    const from = isDay(url.searchParams.get('from'))
      ? url.searchParams.get('from') : localDay(env);
    const span = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 31);
    const days = Array.from({ length: span }, (_, i) => addDays(from, i));

    const [shifts, people] = await Promise.all([
      env.DB.prepare(
        `SELECT id, user_id, user_name, day, start_time, end_time, note
         FROM roster WHERE day BETWEEN ? AND ? ORDER BY day, start_time, user_name`,
      ).bind(days[0], days[days.length - 1]).all(),
      env.DB.prepare(
        `SELECT id, name, role, availability FROM users WHERE active = 1 ORDER BY name`,
      ).all(),
    ]);

    const workedMinutes = new Map();
    for (const r of shifts.results) {
      const span = toMinutes(r.end_time) - toMinutes(r.start_time);
      workedMinutes.set(r.user_id, (workedMinutes.get(r.user_id) ?? 0) + (span > 0 ? span : 0));
    }

    // Hours against a target are a management figure, not something a cleaner
    // should be reading off a colleague's row - so they are left out of the
    // response entirely rather than merely hidden by the front end.
    const canSeeHours = user.role !== 'cleaner';

    const staff = people.results.map((p) => {
      const { days: avail, idealHours } = parseAvailability(p.availability);
      return {
        id: p.id,
        name: p.name,
        role: p.role,
        availability: avail,
        ...(canSeeHours ? {
          idealHours,
          rosteredHours: Math.round(((workedMinutes.get(p.id) ?? 0) / 60) * 10) / 10,
        } : {}),
      };
    });
    const byId = new Map(staff.map((p) => [p.id, p]));

    // Flag anything already on the roster that no longer fits: availability
    // often changes after the roster is built, and a warning that only fired
    // at save time would never be seen again.
    const withFlags = shifts.results.map((s) => {
      const person = byId.get(s.user_id);
      const window = person ? person.availability[weekdayIndex(s.day)] : null;
      const flags = [];
      if (person && !window) flags.push('unavailable');
      else if (window?.from && window?.to) {
        if (toMinutes(s.start_time) < toMinutes(window.from)
          || toMinutes(s.end_time) > toMinutes(window.to)) flags.push('outside');
      }
      const clash = shifts.results.some((o) => o.id !== s.id && o.user_id === s.user_id
        && o.day === s.day
        && toMinutes(s.start_time) < toMinutes(o.end_time)
        && toMinutes(s.end_time) > toMinutes(o.start_time));
      if (clash) flags.push('overlap');
      return { ...s, flags };
    });

    return json({
      from,
      days,
      today: localDay(env),
      shifts: withFlags,
      staff,
      canEdit: user.role !== 'cleaner',
    });
  },

  'POST /roster': async (req, env, { user }) => {
    require(user, 'office', 'admin');
    const body = await req.json();
    const id = body.id ? Number(body.id) : null;
    const userId = Number(body.userId);
    const day = isDay(body.day) ? body.day : null;
    const from = clean(body.start, 5);
    const to = clean(body.end, 5);

    if (!day) throw new HttpError(400, 'Pick a date for the shift.');
    if (!TIME_RE.test(from) || !TIME_RE.test(to)) {
      throw new HttpError(400, 'Start and finish times must look like 08:00.');
    }
    if (toMinutes(to) <= toMinutes(from)) {
      throw new HttpError(400, 'The finish time has to be after the start time.');
    }

    const { person, conflicts } = await rosterConflicts(env, {
      userId, day, from, to, ignoreId: id,
    });

    // 409 rather than a silent save: the office gets told what is wrong and
    // can either fix it or say "yes, I know" by resending with force.
    if (conflicts.length && !body.force) {
      throw new HttpError(409, conflicts.map((c) => c.message).join(' '), { conflicts });
    }

    const note = clean(body.note, 200);

    const ts = now();

    if (id) {
      const res = await env.DB.prepare(
        `UPDATE roster SET user_id = ?, user_name = ?, day = ?, start_time = ?, end_time = ?,
           note = ?, updated_at = ? WHERE id = ?`,
      ).bind(person.id, person.name, day, from, to, note, ts, id).run();
      if (!res.meta.changes) throw new HttpError(404, 'That shift no longer exists.');
      return json({ ok: true, id, conflicts });
    }

    const res = await env.DB.prepare(
      `INSERT INTO roster
         (user_id, user_name, day, start_time, end_time, note,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(person.id, person.name, day, from, to, note, user.name, ts, ts).run();

    return json({ ok: true, id: res.meta.last_row_id, conflicts });
  },

  'POST /roster/delete': async (req, env, { user }) => {
    require(user, 'office', 'admin');
    const id = Number((await req.json()).id);
    const res = await env.DB.prepare('DELETE FROM roster WHERE id = ?').bind(id).run();
    if (!res.meta.changes) throw new HttpError(404, 'That shift has already gone.');
    return json({ ok: true });
  },

  /**
   * Copies a whole week forward. Most weeks at a camp are last week with two
   * changes, and retyping thirty shifts to make those two is how rosters end
   * up not being kept at all.
   */
  'POST /roster/copy': async (req, env, { user }) => {
    require(user, 'office', 'admin');
    const { from, to } = await req.json();
    if (!isDay(from) || !isDay(to)) throw new HttpError(400, 'Pick both weeks.');

    const fromEnd = addDays(from, 6);
    const [{ results: source }, existing] = await Promise.all([
      env.DB.prepare(
        `SELECT user_id, user_name, day, start_time, end_time, note
         FROM roster WHERE day BETWEEN ? AND ?`,
      ).bind(from, fromEnd).all(),
      env.DB.prepare(
        'SELECT COUNT(*) AS n FROM roster WHERE day BETWEEN ? AND ?',
      ).bind(to, addDays(to, 6)).first(),
    ]);

    if (!source.length) throw new HttpError(400, 'That week has no shifts to copy.');
    if (existing.n) {
      throw new HttpError(409, `The target week already has ${existing.n} shift${
        existing.n === 1 ? '' : 's'}. Clear it first, or pick another week.`);
    }

    const offset = Math.round(
      (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400_000,
    );
    const ts = now();

    await env.DB.batch(source.map((s) => env.DB.prepare(
      `INSERT INTO roster
         (user_id, user_name, day, start_time, end_time, note,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      s.user_id, s.user_name, addDays(s.day, offset), s.start_time, s.end_time,
      s.note, user.name, ts, ts,
    )));

    return json({ ok: true, copied: source.length });
  },

  'GET /roster/export': async (_req, env, { user, url }) => {
    require(user, 'office', 'admin');
    const from = isDay(url.searchParams.get('from'))
      ? url.searchParams.get('from') : localDay(env);
    const to = addDays(from, 6);

    const { results } = await env.DB.prepare(
      `SELECT day, user_name, start_time, end_time, note
       FROM roster WHERE day BETWEEN ? AND ? ORDER BY day, start_time, user_name`,
    ).bind(from, to).all();

    const auDay = (d) => (d ? d.split('-').reverse().join('-') : '');
    const header = 'Date,Day,Staff,Start,Finish,Notes\n';
    const csv = results.map((r) => [
      auDay(r.day), DAY_NAMES[weekdayIndex(r.day)], r.user_name,
      r.start_time, r.end_time, r.note,
    ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');

    return new Response(header + csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="roster-week-${auDay(from)}.csv"`,
      },
    });
  },

  /* --- editing the checklist from inside the app --- */

  'GET /admin/checklist': async (_req, env, { user, url }) => {
    require(user, 'admin');
    const cleanType = typeOf(url.searchParams.get('type'));
    const other = CLEAN_TYPES.find((t) => t !== cleanType);

    const { results: buildings } = await env.DB.prepare(
      'SELECT id, name, grp, sort_order, active FROM buildings ORDER BY sort_order, name',
    ).all();
    // A building's list is a handful of broad areas now, not forty jobs, so
    // the whole checklist comes back in one request and opening a building
    // costs nothing. The history counts ride along because deleting an item
    // should be a decision - the dialog can say what goes with it.
    const { results: rows } = await env.DB.prepare(
      `SELECT t.id, t.building_id, t.item, t.description, t.photo_mode, t.clean_type,
              t.sort_order, t.active,
              (SELECT COUNT(*) FROM task_log l WHERE l.task_id = t.id) AS history,
              (SELECT COUNT(*) FROM task_photos p WHERE p.task_id = t.id) AS photos
       FROM tasks t ORDER BY t.sort_order, t.id`,
    ).all();

    const items = {};
    const otherCounts = {};
    for (const t of rows) {
      if (t.clean_type === cleanType || t.clean_type === 'both') {
        (items[t.building_id] ??= []).push(t);
      }
      // Counts for the other checklist, so its tab can say how big it is
      // before you switch to it.
      if (t.active && (t.clean_type === other || t.clean_type === 'both')) {
        otherCounts[t.building_id] = (otherCounts[t.building_id] ?? 0) + 1;
      }
    }

    return json({
      cleanType,
      buildings,
      items,
      otherCounts,
      source: await getSetting(env, 'checklist_source', 'file'),
      // True when data/checklist.json says something other than what was last
      // written. Without this, a file edit that the app is ignoring looks
      // exactly like a file edit that didn't deploy.
      fileDiffers: await getSetting(env, 'checklist_version', '') !== await checklistVersion(),
    });
  },

  'POST /admin/building': async (req, env, { user }) => {
    require(user, 'admin');
    const { id, name, group, active } = await req.json();
    const label = clean(name, 80);
    if (!label) throw new HttpError(400, 'Give the building a name.');
    const grp = clean(group, 60);

    // Renaming onto an existing name used to hit the unique index and come
    // back as a blank 500.
    const clash = await env.DB.prepare(
      'SELECT id FROM buildings WHERE name = ? AND id IS NOT ?',
    ).bind(label, id ? Number(id) : null).first();
    if (clash) throw new HttpError(400, 'A building with that name already exists.');

    if (id) {
      await env.DB.prepare('UPDATE buildings SET name = ?, grp = ?, active = ? WHERE id = ?')
        .bind(label, grp, active ? 1 : 0, Number(id)).run();
    } else {
      const max = await env.DB.prepare('SELECT MAX(sort_order) AS m FROM buildings').first();
      await env.DB.prepare(
        'INSERT INTO buildings (name, grp, sort_order, active) VALUES (?, ?, ?, 1)',
      ).bind(label, grp, (max?.m ?? 0) + 1).run();
    }
    await ownChecklist(env);
    return json({ ok: true });
  },

  /**
   * Hard delete of a whole building. Everything below it goes: both
   * checklists, every tick, every photo, its schedule and its reports. Hiding
   * is the everyday tool and the UI says so; this exists for the building
   * that was added by mistake.
   */
  'POST /admin/building/delete': async (req, env, { user }) => {
    require(user, 'admin');
    const { id, confirm } = await req.json();
    const bid = Number(id);
    const building = await env.DB.prepare('SELECT id, name FROM buildings WHERE id = ?')
      .bind(bid).first();
    if (!building) throw new HttpError(404, 'Building not found.');
    if (clean(confirm, 80) !== building.name) {
      throw new HttpError(400, 'Type the building name exactly to confirm.');
    }

    const { results: photos } = await env.DB.prepare(
      `SELECT p.photo_key FROM task_photos p
       JOIN tasks t ON t.id = p.task_id WHERE t.building_id = ?`,
    ).bind(bid).all();
    const { results: reportPhotos } = await env.DB.prepare(
      'SELECT photo_key FROM maintenance WHERE building_id = ? AND photo_key IS NOT NULL',
    ).bind(bid).all();

    // D1 does not enforce ON DELETE CASCADE, so each table is cleared by hand.
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM task_photos WHERE task_id IN (
           SELECT id FROM tasks WHERE building_id = ?)`,
      ).bind(bid),
      env.DB.prepare(
        `DELETE FROM task_log WHERE task_id IN (
           SELECT id FROM tasks WHERE building_id = ?)`,
      ).bind(bid),
      env.DB.prepare('DELETE FROM tasks WHERE building_id = ?').bind(bid),
      env.DB.prepare('DELETE FROM schedule WHERE building_id = ?').bind(bid),
      env.DB.prepare('DELETE FROM building_status WHERE building_id = ?').bind(bid),
      env.DB.prepare('DELETE FROM maintenance WHERE building_id = ?').bind(bid),
      env.DB.prepare('DELETE FROM activity WHERE building_id = ?').bind(bid),
      env.DB.prepare('DELETE FROM buildings WHERE id = ?').bind(bid),
    ]);

    await dropPhotos(env, [
      ...photos.map((p) => p.photo_key),
      ...reportPhotos.map((p) => p.photo_key),
    ]);
    await ownChecklist(env);
    return json({ ok: true, name: building.name });
  },

  /**
   * Puts a building's Full Clean list onto its Check list, or the other way
   * round. Rather than copying rows, an entry that is on one list is promoted
   * to "both" - same row, so every tick and photo it has ever recorded stays
   * with it, and later renaming it renames it on both lists at once.
   */
  'POST /admin/checklist/copy': async (req, env, { user }) => {
    require(user, 'admin');
    const { buildingId, from, to, itemIds } = await req.json();
    const bid = Number(buildingId);
    const source = typeOf(from);
    const target = typeOf(to, source === 'full' ? 'check' : 'full');
    if (source === target) throw new HttpError(400, 'Pick two different checklists.');

    const wanted = Array.isArray(itemIds) ? itemIds.map(Number) : null;
    // Only entries that are on the source alone: a "both" entry is already
    // on the target by definition.
    const { results: rows } = await env.DB.prepare(
      `SELECT id, item FROM tasks
       WHERE building_id = ? AND clean_type = ? AND active = 1 ORDER BY sort_order, id`,
    ).bind(bid, source).all();

    const picked = wanted ? rows.filter((t) => wanted.includes(t.id)) : rows;
    if (!picked.length) throw new HttpError(400, 'Nothing to copy.');

    // A name already sitting on the target as its own entry is left alone -
    // silently merging two rows would take somebody's history with it.
    const { results: onTarget } = await env.DB.prepare(
      'SELECT item FROM tasks WHERE building_id = ? AND clean_type = ?',
    ).bind(bid, target).all();
    const taken = new Set(onTarget.map((t) => t.item));

    const moving = picked.filter((t) => !taken.has(t.item));
    if (!moving.length) {
      throw new HttpError(400, `Every one of those is already on the ${
        typeLabel(target)} checklist.`);
    }

    await env.DB.batch(moving.map((t) => env.DB.prepare(
      `UPDATE tasks SET clean_type = 'both' WHERE id = ?`,
    ).bind(t.id)));

    await ownChecklist(env);
    return json({ ok: true, items: moving.length, target });
  },

  'POST /admin/task': async (req, env, { user }) => {
    require(user, 'admin');
    const { id, buildingId, cleanType, item, description, active, photoMode } = await req.json();
    const label = clean(item, 100);
    if (!label) throw new HttpError(400, 'Give the item a name.');
    const detail = clean(description, 300);
    const photo = PHOTO_MODES.includes(photoMode) ? photoMode : 'none';

    /**
     * Two entries clash when they would both show on the same checklist.
     * "both" overlaps everything; a Full Clean entry and a Check entry of the
     * same name are two separate lists and are fine.
     */
    const clashes = async (bid, type, exceptId) => {
      const overlap = type === 'both' ? ['full', 'check', 'both'] : [type, 'both'];
      return env.DB.prepare(
        `SELECT id, active FROM tasks
         WHERE building_id = ? AND item = ? AND id IS NOT ?
           AND clean_type IN (${overlap.map(() => '?').join(', ')})`,
      ).bind(bid, label, exceptId ?? null, ...overlap).first();
    };

    if (id) {
      const existing = await env.DB.prepare(
        'SELECT building_id, clean_type FROM tasks WHERE id = ?',
      ).bind(Number(id)).first();
      if (!existing) throw new HttpError(404, 'That item no longer exists.');
      const type = cleanType === 'both' || isCleanType(cleanType)
        ? cleanType : existing.clean_type;

      if (await clashes(existing.building_id, type, Number(id))) {
        throw new HttpError(400, 'That building already has an item with that name on this checklist.');
      }

      await env.DB.prepare(
        `UPDATE tasks SET item = ?, description = ?, photo_mode = ?, clean_type = ?, active = ?
         WHERE id = ?`,
      ).bind(label, detail, photo, type, active ? 1 : 0, Number(id)).run();
    } else {
      const bid = Number(buildingId);
      const type = cleanType === 'both' || isCleanType(cleanType) ? cleanType : 'both';
      const building = await env.DB.prepare('SELECT id FROM buildings WHERE id = ?')
        .bind(bid).first();
      if (!building) throw new HttpError(404, 'That building no longer exists.');

      const clash = await clashes(bid, type, null);
      if (clash?.active) {
        throw new HttpError(400, 'That building already has an item with that name on this checklist.');
      } else if (clash) {
        // Bringing back a retired item keeps everything it has ever recorded,
        // which beats a second row that starts its history from nothing.
        await env.DB.prepare(
          'UPDATE tasks SET active = 1, description = ?, photo_mode = ? WHERE id = ?',
        ).bind(detail, photo, clash.id).run();
      } else {
        const max = await env.DB.prepare(
          'SELECT MAX(sort_order) AS m FROM tasks WHERE building_id = ?',
        ).bind(bid).first();
        await env.DB.prepare(
          `INSERT INTO tasks (building_id, clean_type, item, description, photo_mode, sort_order, active)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
        ).bind(bid, type, label, detail, photo, (max?.m ?? 0) + 1).run();
      }
    }
    await ownChecklist(env);
    return json({ ok: true });
  },

  /**
   * Deletes a checklist item outright.
   *
   * Hiding is still the everyday tool and keeps the history; this is the
   * "that should never have been there" case. It refuses to run silently on
   * an item with recorded history - the caller has to send back the number of
   * records it is about to destroy, which is only possible if the screen
   * actually showed it to somebody.
   */
  'POST /admin/task/delete': async (req, env, { user }) => {
    require(user, 'admin');
    const { id, acknowledgeHistory } = await req.json();
    // Photos count as history too. Counting only the ticks would let an item
    // that has never been ticked but has been photographed a dozen times
    // delete without a word, taking the photos with it.
    const task = await env.DB.prepare(
      `SELECT t.id, t.item,
              (SELECT COUNT(*) FROM task_log l WHERE l.task_id = t.id)
              + (SELECT COUNT(*) FROM task_photos p WHERE p.task_id = t.id) AS history
       FROM tasks t WHERE t.id = ?`,
    ).bind(Number(id)).first();
    if (!task) throw new HttpError(404, 'That item has already gone.');

    if (task.history && Number(acknowledgeHistory) !== task.history) {
      throw new HttpError(409,
        `"${task.item}" has ${task.history} record${task.history === 1 ? '' : 's'} against it. `
        + 'Hide it instead to keep them, or confirm to delete both.',
        { history: task.history });
    }

    const { results: photos } = await env.DB.prepare(
      'SELECT photo_key FROM task_photos WHERE task_id = ?',
    ).bind(task.id).all();

    await env.DB.batch([
      env.DB.prepare('DELETE FROM task_photos WHERE task_id = ?').bind(task.id),
      env.DB.prepare('DELETE FROM task_log WHERE task_id = ?').bind(task.id),
      env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(task.id),
    ]);
    await dropPhotos(env, photos.map((p) => p.photo_key));
    await ownChecklist(env);
    return json({ ok: true, item: task.item, history: task.history });
  },

  /**
   * Writes a new order for a building's checklist items, or for the
   * buildings themselves.
   *
   * The whole id list is sent and has to match what is on the server exactly.
   * That is the concurrency guard: if somebody else added or removed a row
   * while this screen was open, the sets differ and the reorder is refused
   * rather than quietly resurrecting a stale list over the top of their work.
   */
  'POST /admin/reorder': async (req, env, { user }) => {
    require(user, 'admin');
    const { kind, parentId, cleanType, ids } = await req.json();
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Nothing to reorder.');
    const wanted = ids.map(Number);
    if (wanted.some((n) => !Number.isInteger(n))) throw new HttpError(400, 'Bad ordering.');

    let current;
    if (kind === 'items') {
      const { results } = await env.DB.prepare(
        `SELECT id FROM tasks WHERE building_id = ?1 AND clean_type IN (?2, 'both')`,
      ).bind(Number(parentId), typeOf(cleanType)).all();
      current = results;
    } else if (kind === 'buildings') {
      const { results } = await env.DB.prepare('SELECT id FROM buildings').all();
      current = results;
    } else {
      throw new HttpError(400, 'Unknown thing to reorder.');
    }

    const have = new Set(current.map((r) => r.id));
    const same = have.size === wanted.length && wanted.every((id) => have.has(id));
    if (!same) {
      throw new HttpError(409,
        'This list changed while you were reordering it. Reload the page and try again.');
    }

    const table = { items: 'tasks', buildings: 'buildings' }[kind];
    await env.DB.batch(wanted.map((id, i) =>
      env.DB.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`).bind(i, id)));

    await ownChecklist(env);
    return json({ ok: true, ordered: wanted.length });
  },

  /** Hands the checklist back to data/checklist.json, and applies it now. */
  'POST /admin/checklist/restore': async (req, env, { user }) => {
    require(user, 'admin');
    const { confirm } = await req.json();
    if (clean(confirm, 40).toLowerCase() !== 'restore') {
      throw new HttpError(400, 'Type "restore" to confirm.');
    }
    await setSetting(env, 'checklist_source', 'file');
    // Written here rather than left for the next cold start: the admin is
    // watching this screen, and the whole point of the button is that the
    // list they are looking at changes.
    const counts = await applyChecklistFile(env.DB);
    return json({ ok: true, ...counts });
  },

  'POST /settings': async (req, env, { user }) => {
    require(user, 'admin');
    const { quickSignin } = await req.json();
    if (quickSignin !== undefined) {
      await setSetting(env, 'quick_signin', quickSignin ? '1' : '0');
    }
    return json({ ok: true, quickSignin: await quickSigninOn(env) });
  },

  /* --- maintenance push notifications (ntfy.sh) --- */

  'GET /admin/notifications': async (_req, env, { user }) => {
    require(user, 'admin');
    const topic = await getSetting(env, 'ntfy_topic', '');
    return json({ topic, server: NTFY_SERVER });
  },

  'POST /admin/notifications': async (req, env, { user }) => {
    require(user, 'admin');
    const topic = clean((await req.json()).topic, 64);
    if (topic && !NTFY_TOPIC_RE.test(topic)) {
      throw new HttpError(400, 'Topic can only contain letters, numbers, - and _.');
    }
    await setSetting(env, 'ntfy_topic', topic);
    return json({ ok: true, topic });
  },

  /** Lets an admin confirm the setup actually works, with a real error if not. */
  'POST /admin/notifications/test': async (_req, env, { user }) => {
    require(user, 'admin');
    const topic = await getSetting(env, 'ntfy_topic', '');
    if (!topic) throw new HttpError(400, 'Set a topic first.');

    try {
      await publishNtfy(topic, {
        title: '✅ Test notification',
        message: `Sent by ${user.name} from Woodhouse Cleaning. If this arrived, maintenance `
          + 'alerts are working.',
        priority: 3,
        tags: ['white_check_mark'],
      });
    } catch (err) {
      throw new HttpError(502, `Could not reach ntfy.sh: ${err.message}`);
    }
    return json({ ok: true });
  },

  /**
   * Wipes operational data so the camp can start clean after testing.
   * Deliberately never drops a table and never touches the checklist itself -
   * the buildings and their items come from checklist.json.
   */
  'POST /admin/reset': async (req, env, { user }) => {
    require(user, 'admin');
    const { confirm, includePeople } = await req.json();
    if (clean(confirm, 40).toLowerCase() !== 'clear database') {
      throw new HttpError(400, 'Type "clear database" exactly to confirm.');
    }

    // Bin the stored photos first, while we can still read their keys.
    if (env.PHOTOS) {
      const [reports, items] = await Promise.all([
        env.DB.prepare('SELECT photo_key FROM maintenance WHERE photo_key IS NOT NULL').all(),
        env.DB.prepare('SELECT photo_key FROM task_photos').all(),
      ]);
      await dropPhotos(env, [
        ...reports.results.map((p) => p.photo_key),
        ...items.results.map((p) => p.photo_key),
      ]);
    }

    const tables = [
      'schedule', 'roster', 'task_photos', 'task_log',
      'activity', 'building_status', 'maintenance', 'login_attempts',
    ];
    await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));

    let removedPeople = 0;
    if (includePeople) {
      // Everyone except you - otherwise nobody could sign back in.
      const res = await env.DB.prepare('DELETE FROM users WHERE id != ?')
        .bind(user.id).run();
      removedPeople = res.meta.changes ?? 0;
    }

    return json({ ok: true, cleared: tables, removedPeople });
  },

  'GET /report': async (req, env, { user, url }) => {
    require(user, 'office', 'admin');
    const from = isDay(url.searchParams.get('from')) ? url.searchParams.get('from') : localDay(env);
    const to = isDay(url.searchParams.get('to')) ? url.searchParams.get('to') : localDay(env);
    const { results } = await env.DB.prepare(
      // Photo counts come from a join rather than a per-row subquery: a month
      // of a full park is tens of thousands of rows, and one extra query each
      // is the difference between an export and a timeout.
      `SELECT l.id, l.day, b.name AS building, t.clean_type, t.item,
              l.user_name, l.updated_at, COUNT(p.id) AS photos
       FROM task_log l
       JOIN tasks t ON t.id = l.task_id
       JOIN buildings b ON b.id = t.building_id
       LEFT JOIN task_photos p ON p.task_id = t.id AND p.day = l.day
       WHERE l.done = 1 AND l.day BETWEEN ? AND ?
       GROUP BY l.id
       ORDER BY l.day DESC, b.sort_order, t.sort_order`,
    ).bind(from, to).all();

    const auDay = (d) => (d ? d.split('-').reverse().join('-') : '');
    const header = 'Date,Building,Checklist,Item,Cleaned by,Time,Photos\n';
    const csv = results.map((r) => [
      auDay(r.day), r.building,
      r.clean_type === 'both' ? 'Both' : typeLabel(r.clean_type),
      r.item, r.user_name ?? '', r.updated_at ?? '', r.photos,
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');

    return new Response(header + csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="cleaning-${auDay(from)}-to-${auDay(to)}.csv"`,
      },
    });
  },
};

/* ---------------------------------------------------------------- routing */

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
  const key = `${request.method} ${path}`;
  const handler = routes[key];

  if (!handler) return fail(404, `No such endpoint: ${key}`);

  try {
    // Creates the tables on the first request after a deploy; a no-op on
    // every request after that. Rewriting the checklist from the file is
    // handed to waitUntil, so a big edit never sits in front of a page load.
    signingKey = await ensureReady(env, waitUntil);
  } catch (err) {
    console.error('setup', err);
    return fail(503, err.message);
  }

  try {
    // /config, /bootstrap and /login are the only routes reachable signed out.
    const open = ['GET /config', 'POST /bootstrap', 'POST /login', 'GET /people']
      .includes(key);
    const user = open ? null : await currentUser(request, env);
    if (!open && !user) return fail(401, 'Please sign in.');
    return await handler(request, env, { user, url, waitUntil });
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message, err.extra);
    if (err instanceof SyntaxError) return fail(400, 'Malformed request.');
    console.error(key, err);
    return fail(500, 'Something went wrong. Please try again.');
  }
}
