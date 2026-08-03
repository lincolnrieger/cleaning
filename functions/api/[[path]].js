// Basecamp Cleaning Tracker - API
// Single Cloudflare Pages Function handling every /api/* route.

import { ensureReady, contacts } from './_setup.js';

const TOKEN_TTL_HOURS = 14; // covers a long shift, expires before the next day
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

/* ------------------------------------------------------------------ utils */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const fail = (status, message) => json({ error: message }, status);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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

function dayParam(url, env) {
  const d = url.searchParams.get('day');
  return isDay(d) ? d : localDay(env);
}

const now = () => new Date().toISOString();

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
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

async function buildingIdForTask(env, taskId) {
  const row = await env.DB.prepare(
    `SELECT a.building_id AS building_id, a.name AS area, t.item AS item
     FROM tasks t JOIN areas a ON a.id = t.area_id
     WHERE t.id = ? AND t.active = 1`,
  ).bind(taskId).first();
  if (!row) throw new HttpError(404, 'That task no longer exists.');
  return row;
}

const routes = {
  /* --- session --- */

  'GET /config': async (_req, env) => {
    const bootstrapped = await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first();
    return json({
      needsBootstrap: !bootstrapped,
      photos: Boolean(env.PHOTOS),
      rollupOnly: env.OFFICE_ROLLUP_ONLY === '1',
      officePhone: env.OFFICE_PHONE || contacts.office || '',
      maintenancePhone: env.MAINTENANCE_PHONE || contacts.maintenance || '',
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
      'INSERT INTO users (name, role, pin_hash) VALUES (?, ?, ?)',
    ).bind(who, 'admin', await hashPin(env, pin)).run();
    return json({ ok: true });
  },

  'POST /login': async (req, env) => {
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    const guard = await loginGuard(env, ip);

    const { pin } = await req.json();
    const user = /^\d{4,8}$/.test(pin || '')
      ? await env.DB.prepare(
          'SELECT id, name, role FROM users WHERE pin_hash = ? AND active = 1',
        ).bind(await hashPin(env, pin)).first()
      : null;

    if (!user) {
      await recordFail(env, ip, guard);
      throw new HttpError(401, 'PIN not recognised.');
    }

    await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
    const token = await sign(env, {
      uid: user.id,
      exp: Date.now() + TOKEN_TTL_HOURS * 3600_000,
    });
    return json({ token, user });
  },

  'GET /me': async (req, env, { user }) => json({ user: require(user) }),

  /* --- office rollup --- */

  'GET /overview': async (req, env, { user, url }) => {
    canRead(user);
    const day = dayParam(url, env);

    const { results: buildings } = await env.DB.prepare(
      `SELECT b.id, b.name,
        (SELECT COUNT(*) FROM tasks t JOIN areas a ON a.id = t.area_id
           WHERE a.building_id = b.id AND t.active = 1) AS total,
        (SELECT COUNT(*) FROM task_log l JOIN tasks t ON t.id = l.task_id
           JOIN areas a ON a.id = t.area_id
           WHERE a.building_id = b.id AND l.day = ?1 AND l.done = 1 AND t.active = 1) AS done,
        (SELECT MAX(l.updated_at) FROM task_log l JOIN tasks t ON t.id = l.task_id
           JOIN areas a ON a.id = t.area_id
           WHERE a.building_id = b.id AND l.day = ?1) AS last_at,
        (SELECT COUNT(*) FROM maintenance m
           WHERE m.building_id = b.id AND m.status = 'open') AS open_issues,
        (SELECT bs.completed_at FROM building_status bs
           WHERE bs.building_id = b.id AND bs.day = ?1) AS completed_at,
        (SELECT bs.completed_by FROM building_status bs
           WHERE bs.building_id = b.id AND bs.day = ?1) AS completed_by
       FROM buildings b WHERE b.active = 1
       ORDER BY b.sort_order, b.name`,
    ).bind(day).all();

    // Who has touched each building today, so the office can see overlap.
    const { results: crew } = await env.DB.prepare(
      `SELECT a.building_id AS building_id, l.user_name AS name, MAX(l.updated_at) AS last_at
       FROM task_log l
       JOIN tasks t ON t.id = l.task_id
       JOIN areas a ON a.id = t.area_id
       WHERE l.day = ?1 AND l.user_name IS NOT NULL
       GROUP BY a.building_id, l.user_name
       ORDER BY last_at DESC`,
    ).bind(day).all();

    const byBuilding = new Map();
    for (const c of crew) {
      if (!byBuilding.has(c.building_id)) byBuilding.set(c.building_id, []);
      byBuilding.get(c.building_id).push(c.name);
    }

    return json({
      day,
      buildings: buildings.map((b) => ({ ...b, crew: byBuilding.get(b.id) ?? [] })),
    });
  },

  'GET /activity': async (req, env, { user, url }) => {
    canRead(user);
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

    const { results: rows } = await env.DB.prepare(
      `SELECT a.id AS area_id, a.name AS area_name, a.sort_order AS area_sort,
              t.id AS task_id, t.item, t.description, t.sort_order AS task_sort,
              l.done, l.user_name, l.updated_at
       FROM areas a
       JOIN tasks t ON t.area_id = a.id AND t.active = 1
       LEFT JOIN task_log l ON l.task_id = t.id AND l.day = ?2
       WHERE a.building_id = ?1
       ORDER BY a.sort_order, a.name, t.sort_order, t.id`,
    ).bind(id, day).all();

    const areas = [];
    for (const r of rows) {
      let area = areas.find((a) => a.id === r.area_id);
      if (!area) {
        area = { id: r.area_id, name: r.area_name, tasks: [] };
        areas.push(area);
      }
      area.tasks.push({
        id: r.task_id,
        item: r.item,
        description: r.description,
        done: Boolean(r.done),
        by: r.user_name,
        at: r.updated_at,
      });
    }

    const status = await env.DB.prepare(
      'SELECT completed_at, completed_by FROM building_status WHERE building_id = ? AND day = ?',
    ).bind(id, day).first();

    const { results: issues } = await env.DB.prepare(
      `SELECT id, kind, detail, photo_key, status, reported_by, reported_at
       FROM maintenance WHERE building_id = ? AND status = 'open' ORDER BY id DESC`,
    ).bind(id).all();

    return json({
      day,
      building,
      areas,
      completed: status ?? null,
      issues,
      readOnly: user.role === 'office',
    });
  },

  'POST /task': async (req, env, { user }) => {
    canTick(user);
    const { taskId, done, day: rawDay } = await req.json();
    const day = isDay(rawDay) ? rawDay : localDay(env);
    const task = await buildingIdForTask(env, Number(taskId));
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
      detail: `${task.area} - ${task.item}`,
      userName: user.name,
    });

    return json({ ok: true, at: ts, by: user.name });
  },

  'POST /building/complete': async (req, env, { user }) => {
    canTick(user);
    const { buildingId, day: rawDay, undo } = await req.json();
    const day = isDay(rawDay) ? rawDay : localDay(env);
    const id = Number(buildingId);

    if (undo) {
      await env.DB.prepare('DELETE FROM building_status WHERE building_id = ? AND day = ?')
        .bind(id, day).run();
      await logActivity(env, {
        day, buildingId: id, kind: 'reopened',
        detail: 'Building reopened', userName: user.name,
      });
      return json({ ok: true, completed: null });
    }

    const ts = now();
    await env.DB.prepare(
      `INSERT INTO building_status (building_id, day, completed_at, completed_by)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(building_id, day) DO UPDATE SET
         completed_at = excluded.completed_at, completed_by = excluded.completed_by`,
    ).bind(id, day, ts, user.name).run();

    await logActivity(env, {
      day, buildingId: id, kind: 'completed',
      detail: 'Marked complete', userName: user.name,
    });
    return json({ ok: true, completed: { completed_at: ts, completed_by: user.name } });
  },

  /* --- maintenance and lost property --- */

  'GET /maintenance': async (req, env, { user, url }) => {
    canRead(user);
    const status = url.searchParams.get('status') === 'resolved' ? 'resolved' : 'open';
    const { results } = await env.DB.prepare(
      `SELECT m.id, m.kind, m.detail, m.photo_key, m.status, m.day,
              m.reported_by, m.reported_at, m.resolved_by, m.resolved_at,
              b.name AS building, a.name AS area
       FROM maintenance m
       JOIN buildings b ON b.id = m.building_id
       LEFT JOIN areas a ON a.id = m.area_id
       WHERE m.status = ? ORDER BY m.id DESC LIMIT 200`,
    ).bind(status).all();
    return json({ items: results });
  },

  'POST /maintenance': async (req, env, { user }) => {
    require(user, 'cleaner', 'office', 'admin');
    const { buildingId, areaId, detail, kind, photoKey } = await req.json();
    const text = clean(detail, 1000);
    if (!text) throw new HttpError(400, 'Please describe the problem.');

    const type = kind === 'lost_property' ? 'lost_property' : 'maintenance';
    const day = localDay(env);
    const id = Number(buildingId);

    const building = await env.DB.prepare(
      'SELECT name FROM buildings WHERE id = ? AND active = 1',
    ).bind(id).first();
    if (!building) throw new HttpError(404, 'Building not found.');

    const res = await env.DB.prepare(
      `INSERT INTO maintenance
         (building_id, area_id, kind, detail, photo_key, day, reported_by, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, areaId ? Number(areaId) : null, type, text,
      clean(photoKey, 200) || null, day, user.name, now(),
    ).run();

    await logActivity(env, {
      day, buildingId: id,
      kind: type === 'lost_property' ? 'lost_property' : 'issue',
      detail: text, userName: user.name,
    });

    return json({ ok: true, id: res.meta.last_row_id });
  },

  'POST /maintenance/resolve': async (req, env, { user }) => {
    require(user, 'office', 'admin');
    const { id, reopen } = await req.json();
    if (reopen) {
      await env.DB.prepare(
        `UPDATE maintenance SET status = 'open', resolved_by = NULL, resolved_at = NULL
         WHERE id = ?`,
      ).bind(Number(id)).run();
    } else {
      await env.DB.prepare(
        `UPDATE maintenance SET status = 'resolved', resolved_by = ?, resolved_at = ?
         WHERE id = ?`,
      ).bind(user.name, now(), Number(id)).run();
    }
    return json({ ok: true });
  },

  /* --- photos (only when an R2 bucket is bound) --- */

  'POST /photo': async (req, env, { user }) => {
    require(user, 'cleaner', 'office', 'admin');
    if (!env.PHOTOS) throw new HttpError(501, 'Photo uploads are not configured.');

    const type = req.headers.get('content-type') || '';
    if (!/^image\/(jpeg|png|webp)$/.test(type)) {
      throw new HttpError(400, 'Photo must be a JPEG, PNG or WebP image.');
    }
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

  /* --- admin --- */

  'GET /users': async (req, env, { user }) => {
    require(user, 'admin');
    const { results } = await env.DB.prepare(
      'SELECT id, name, role, active, created_at FROM users ORDER BY active DESC, name',
    ).all();
    return json({ users: results });
  },

  'POST /users': async (req, env, { user }) => {
    require(user, 'admin');
    const { id, name, role, pin, active } = await req.json();
    const who = clean(name, 60);

    if (id) {
      if (!who) throw new HttpError(400, 'Name is required.');

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
        if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'PIN must be 4-8 digits.');
        await env.DB.prepare('UPDATE users SET pin_hash = ? WHERE id = ?')
          .bind(await hashPin(env, pin), Number(id)).run();
      }
      return json({ ok: true });
    }

    if (!who) throw new HttpError(400, 'Name is required.');
    if (!/^\d{4,8}$/.test(pin || '')) throw new HttpError(400, 'PIN must be 4-8 digits.');
    if (!['cleaner', 'office', 'admin'].includes(role)) {
      throw new HttpError(400, 'Pick a valid role.');
    }
    await env.DB.prepare('INSERT INTO users (name, role, pin_hash) VALUES (?, ?, ?)')
      .bind(who, role, await hashPin(env, pin)).run();
    return json({ ok: true });
  },

  'GET /report': async (req, env, { user, url }) => {
    require(user, 'office', 'admin');
    const from = isDay(url.searchParams.get('from')) ? url.searchParams.get('from') : localDay(env);
    const to = isDay(url.searchParams.get('to')) ? url.searchParams.get('to') : localDay(env);
    const { results } = await env.DB.prepare(
      `SELECT l.day, b.name AS building, a.name AS area, t.item,
              l.user_name, l.updated_at
       FROM task_log l
       JOIN tasks t ON t.id = l.task_id
       JOIN areas a ON a.id = t.area_id
       JOIN buildings b ON b.id = a.building_id
       WHERE l.done = 1 AND l.day BETWEEN ? AND ?
       ORDER BY l.day DESC, b.sort_order, a.sort_order, t.sort_order`,
    ).bind(from, to).all();

    const header = 'Date,Building,Area,Item,Cleaned by,Time\n';
    const csv = results.map((r) =>
      [r.day, r.building, r.area, r.item, r.user_name ?? '', r.updated_at ?? '']
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','),
    ).join('\n');

    return new Response(header + csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="cleaning-${from}-to-${to}.csv"`,
      },
    });
  },
};

/* ---------------------------------------------------------------- routing */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
  const key = `${request.method} ${path}`;
  const handler = routes[key];

  if (!handler) return fail(404, `No such endpoint: ${key}`);

  try {
    // Creates the tables and syncs the checklist on the first request after a
    // deploy; a no-op on every request after that.
    signingKey = await ensureReady(env);
  } catch (err) {
    console.error('setup', err);
    return fail(503, err.message);
  }

  try {
    // /config, /bootstrap and /login are the only routes reachable signed out.
    const open = ['GET /config', 'POST /bootstrap', 'POST /login'].includes(key);
    const user = open ? null : await currentUser(request, env);
    if (!open && !user) return fail(401, 'Please sign in.');
    return await handler(request, env, { user, url });
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message);
    if (err instanceof SyntaxError) return fail(400, 'Malformed request.');
    console.error(key, err);
    return fail(500, 'Something went wrong. Please try again.');
  }
}
