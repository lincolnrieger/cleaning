/**
 * Serves public/ with a stand-in API, so the manual's screenshots can be taken
 * from the real app rather than drawn by hand.
 *
 * Nothing here runs in production. It exists so that when a screen changes,
 * the pictures in docs/cleaner-manual.pdf can be regenerated in one command
 * instead of being staged against a live camp.
 *
 *   node docs/tools/mock-server.mjs    # then open http://127.0.0.1:8787
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

// A fixed day, so the same commands always produce the same pictures.
const TODAY = '2026-09-09';

const config = {
  needsBootstrap: false,
  quickSignin: false,
  photos: true,
  rollupOnly: false,
  officePhone: '0402 930 714',
  maintenancePhone: '0437 316 386',
  cleanTypes: [{ id: 'full', label: 'Full Clean' }, { id: 'check', label: 'Check' }],
  today: TODAY,
};

const people = [
  { id: 3, name: 'Casey Miller', pinLength: 6 },
  { id: 4, name: 'Dana Brooks', pinLength: 6 },
  { id: 5, name: 'Jo Patel', pinLength: 6 },
  { id: 6, name: 'Sam Ellis', pinLength: 6 },
  { id: 7, name: 'Ruth Nolan', pinLength: 6 },
  { id: 1, name: 'Erin Hayes', pinLength: 6 },
];

const me = { id: 3, name: 'Casey Miller', role: 'cleaner' };

/** A building as /overview returns it. Every one has an empty checklist, which
    is how the camp actually runs: turn up, clean it, mark it done. */
const mk = (id, name, o = {}) => ({
  id,
  name,
  grp: '',
  cleanType: o.cleanType ?? 'check',
  total: 0,
  done: 0,
  sizes: { full: 0, check: 0 },
  last_at: null,
  crew: [],
  open_issues: o.open_issues ?? 0,
  completed_at: o.completed_at ?? null,
  completed_by: o.completed_by ?? null,
  signedOff: o.completed_at
    ? [{ cleanType: o.cleanType ?? 'check', at: o.completed_at, by: o.completed_by }]
    : [],
  scheduled: Boolean(o.scheduled),
  priority: o.priority ?? null,
  checkin: Boolean(o.checkin),
  note: o.note ?? null,
  lastCleaned: null,
});

const buildings = [
  mk(1, 'Rymill Centre', {
    scheduled: true, priority: 1, checkin: true, note: 'Group arriving 2pm',
  }),
  mk(2, 'Manor', { scheduled: true, priority: 2 }),
  mk(3, 'Hooper Bunkhouse', { scheduled: true, priority: 3 }),
  mk(4, 'Seeonee Bathrooms', { scheduled: true }),
  mk(5, 'Staff Toilet', {
    scheduled: true, completed_at: `${TODAY}T08:42:00`, completed_by: 'Dana Brooks',
  }),
  mk(6, 'Reception'), mk(7, 'Laundry'), mk(8, 'Stags + Toilets'),
  mk(9, 'Gilwell'), mk(10, 'Brownsea'), mk(11, "Chambers' Chalet"),
];

// Hooper Bunkhouse comes back already signed off, so the manual can show both
// states of the same screen.
const buildingPayload = (id) => {
  const b = buildings.find((x) => x.id === Number(id)) ?? buildings[1];
  const done = Number(id) === 3;
  return {
    day: TODAY,
    building: { id: b.id, name: b.name },
    cleanType: 'check',
    cleanTypeLabel: 'Check',
    sizes: { full: 0, check: 0 },
    scheduledType: 'check',
    scheduleCheckin: b.checkin,
    scheduleNote: b.note,
    items: [],
    completed: done
      ? { completed_at: `${TODAY}T09:15:00`, completed_by: 'Casey Miller' }
      : null,
    issues: [],
    readOnly: false,
  };
};

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const rosterFor = (from, count) => {
  const days = Array.from({ length: count }, (_, i) => addDays(from, i));
  const week = days.length > 1;
  const shifts = [];
  let id = 1;
  for (const d of week ? days.slice(0, 5) : days) {
    shifts.push({
      id: id++, user_id: 3, user_name: 'Casey Miller', day: d,
      start_time: '08:00', end_time: '16:00', note: '', flags: [],
    });
  }
  for (const d of week ? days.slice(0, 4) : days) {
    shifts.push({
      id: id++, user_id: 4, user_name: 'Dana Brooks', day: d,
      start_time: null, end_time: null, note: '', flags: [],
    });
  }
  for (const d of week ? [days[1], days[2], days[4]] : days) {
    shifts.push({
      id: id++, user_id: 5, user_name: 'Jo Patel', day: d,
      start_time: null, end_time: null, note: '', flags: [],
    });
  }
  return {
    from,
    days,
    today: TODAY,
    shifts,
    staff: people.slice(0, 4).map((p) => ({
      id: p.id, name: p.name, role: 'cleaner', availability: [],
    })),
    canEdit: false,
    canPublish: false,
    published: true,
  };
};

/** One cleaner's own availability, as the "My availability" screen wants it. */
const availabilityMine = (from) => {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const weekday = (preferred = false) => ({ from: '08:00', to: '16:00', preferred });
  return {
    from,
    days,
    today: TODAY,
    usual: {
      days: [weekday(true), weekday(), weekday(), weekday(), weekday(), null, null],
      idealHours: 25,
    },
    week: null,
    setBy: null,
    rosterPublished: true,
    rostered: [1, 1, 1, 1, 1, 0, 0],
  };
};

const maintenance = {
  items: [
    {
      id: 9, building: 'Manor', location: 'Room 3, upstairs',
      detail: 'Tap in the basin drips constantly.', photo_key: null,
      status: 'open', reported_by: 'Casey Miller',
      reported_at: `${TODAY}T09:20:00`, day: TODAY,
    },
    {
      id: 8, building: 'Rymill Centre', location: 'Kitchen',
      detail: 'Hand towel dispenser is broken off the wall.', photo_key: null,
      status: 'open', reported_by: 'Dana Brooks',
      reported_at: `${TODAY}T08:05:00`, day: TODAY,
    },
  ],
};

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const json = (res, obj) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

export function startServer(port = 8787) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // No service worker: a cached shell between runs would make one screenshot
    // a build behind the rest.
    if (p === '/sw.js') { res.writeHead(404); return res.end(); }

    if (p.startsWith('/api/')) {
      const route = p.slice(4);
      if (route === '/config') return json(res, config);
      if (route === '/people') return json(res, { people });
      if (route === '/login' || route === '/session/refresh') {
        return json(res, { token: 'demo-token', user: me });
      }
      if (route === '/overview') {
        return json(res, {
          day: url.searchParams.get('day') || TODAY, buildings, planPublished: true,
        });
      }
      if (route === '/roster') {
        return json(res, rosterFor(
          url.searchParams.get('from') || TODAY,
          Number(url.searchParams.get('days') || 1),
        ));
      }
      if (route === '/availability/mine') {
        return json(res, availabilityMine(url.searchParams.get('from') || TODAY));
      }
      if (route === '/building') return json(res, buildingPayload(url.searchParams.get('id')));
      if (route === '/maintenance') return json(res, maintenance);
      if (route === '/building/complete') {
        return json(res, {
          completed: { completed_at: `${TODAY}T09:15:00`, completed_by: me.name },
        });
      }
      return json(res, {});
    }

    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      });
      res.end(data);
    });
  });

  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
  console.log('Mock app on http://127.0.0.1:8787');
}
