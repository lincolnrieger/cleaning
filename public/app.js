/* Basecamp Cleaning Tracker - front end.
   No framework, no build step. Hash routing, optimistic ticks, light polling. */

'use strict';

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const bar = $('#bar');
const nav = $('#nav');

const state = {
  token: localStorage.getItem('bc.token') || '',
  user: JSON.parse(localStorage.getItem('bc.user') || 'null'),
  config: null,
  configAt: 0,
  day: null,       // day being viewed; null means "today"
  weekFrom: null,  // first column of the schedule grid
  poll: null,
  building: null,  // data for the checklist currently on screen
  cleaners: null,  // cached list for the assignment picker
};

// Chrome/Edge/Android hold this event back until asked for it. Capturing it
// is what lets the login screen offer its own "Install" button instead of
// installation being buried in the browser's menu, where almost nobody finds it.
let deferredInstall = null;

/* ------------------------------------------------------------------ utils */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function time(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Calendar maths on YYYY-MM-DD, in UTC so daylight saving can't shift a day. */
function addDays(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const asDate = (day) => new Date(`${day}T00:00:00Z`);

/** Australian day-first format: 2026-08-04 -> 04-08-2026. */
const auDate = (day) => (day ? day.split('-').reverse().join('-') : '');

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Monday = 0, to match DAY_NAMES and the stored availability array. */
const weekdayIndex = (day) => (asDate(day).getUTCDay() + 6) % 7;

// The API always sends availability pre-parsed: 7 entries, each null (not
// working) or { from, to }. Missing data defaults open rather than closed -
// nobody should read as unavailable just because their record predates this.
const worksOn = (person, day) =>
  !Array.isArray(person.availability) || Boolean(person.availability[weekdayIndex(day)]);

function dayLabel(day) {
  if (!day) return '';
  if (day === state.config?.today) return 'Today';
  if (day === addDays(state.config?.today, -1)) return 'Yesterday';
  if (day === addDays(state.config?.today, 1)) return 'Tomorrow';
  return asDate(day).toLocaleDateString([], {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

const weekdayShort = (day) =>
  asDate(day).toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' });
const dayOfMonth = (day) =>
  asDate(day).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "3 days ago" style text for the last time a building was signed off. */
function sinceLabel(day, today) {
  if (!day) return 'never signed off';
  const gap = Math.round((asDate(today) - asDate(day)) / 86400000);
  if (gap <= 0) return 'signed off today';
  if (gap === 1) return 'signed off yesterday';
  return `signed off ${gap} days ago`;
}

const firstName = (name) => String(name).split(/[\s(]/)[0];

const initials = (name) => String(name)
  .replace(/\(.*?\)/g, '')
  .trim()
  .split(/\s+/)
  .slice(0, 2)
  .map((w) => w[0] || '')
  .join('')
  .toUpperCase() || '?';

/** Stable hue per person, so the same face is the same colour everywhere. */
function hueFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const avatar = (name, size = '') =>
  `<span class="avatar ${size}" style="--h:${hueFor(name)}" title="${esc(name)}"
     >${esc(initials(name))}</span>`;

const avatarStack = (people, size = 'xs') =>
  `<span class="avatar-stack">${people.map((p) => avatar(p.name ?? p, size)).join('')}</span>`;

let toastTimer;
function toast(message, bad = false) {
  document.querySelector('.toast')?.remove();
  const node = document.createElement('div');
  node.className = `toast${bad ? ' bad' : ''}`;
  node.textContent = message;
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), bad ? 4000 : 2000);
}

/* -------------------------------------------------------------- api client */

async function request(path, { method = 'GET', body, raw, contentType } = {}) {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (body && !raw) headers['content-type'] = 'application/json';
  if (contentType) headers['content-type'] = contentType;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && state.token) {
    signOut();
    throw new Error('Your session expired. Please sign in again.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res;
}

async function api(path, opts) {
  return (await request(path, opts)).json();
}

/** Photos need the auth header, so they can't be a plain <img src>. */
async function loadPhoto(img, key) {
  try {
    const res = await request(`/photo?key=${encodeURIComponent(key)}`);
    img.src = URL.createObjectURL(await res.blob());
    img.hidden = false;
  } catch {
    img.remove();
  }
}

function signOut() {
  state.token = '';
  state.user = null;
  state.cleaners = null;
  localStorage.removeItem('bc.token');
  localStorage.removeItem('bc.user');
  location.hash = '';
  render();
}

/* --------------------------------------------------------------- chrome */

const NAV = {
  cleaner: [
    ['', 'My jobs'],
    ['schedule', 'Roster'],
    ['issues', 'Issues'],
  ],
  office: [
    ['', 'Overview'],
    ['schedule', 'Schedule'],
    ['issues', 'Issues'],
    ['history', 'Activity'],
  ],
  admin: [
    ['', 'Overview'],
    ['schedule', 'Schedule'],
    ['issues', 'Issues'],
    ['history', 'Activity'],
    ['buildings', 'Checklists'],
    ['admin', 'People'],
  ],
};

function chrome({ title, back = false, section = '', wide = false }) {
  bar.hidden = !state.user;
  $('#title').textContent = title;
  $('#back').hidden = !back;
  // Detail pages have a back button AND a long building name; the stylesheet
  // uses this to reclaim space on a phone.
  bar.classList.toggle('has-back', back);
  $('#signout').hidden = !state.user;
  document.querySelector('main').classList.toggle('wide', wide);

  const who = $('#who');
  who.hidden = !state.user;
  if (state.user) {
    $('#whoName').textContent = state.user.name;
    const role = $('#whoRole');
    role.textContent = state.user.role;
    role.className = `who-role ${state.user.role}`;
    const av = $('#whoAvatar');
    av.textContent = initials(state.user.name);
    av.style.setProperty('--h', hueFor(state.user.name));
  }

  // Impossible to forget that PIN-less sign-in is switched on.
  const testbar = $('#testbar');
  testbar.hidden = !state.config?.quickSignin;
  testbar.textContent = 'Test mode — anyone can sign in without a PIN. '
    + 'Turn this off under People before real use.';

  const items = state.user ? NAV[state.user.role] ?? [] : [];
  nav.hidden = !items.length;
  nav.innerHTML = items.map(([route, label]) =>
    `<button data-route="${route}" aria-current="${route === section}">${esc(label)}</button>`,
  ).join('');
  nav.querySelectorAll('[data-route]').forEach((b) => {
    b.onclick = () => { location.hash = `#/${b.dataset.route}`; };
  });
}

$('#back').onclick = () => { location.hash = '#/'; };
$('#signout').onclick = async () => {
  if (await ask({
    title: 'Sign out?',
    body: `You are signed in as <strong>${esc(state.user?.name ?? '')}</strong>.`,
    confirmText: 'Sign out',
  })) signOut();
};

function stopPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

/** Runs `fn` on an interval, but only while the tab is actually visible. */
function poll(fn, ms) {
  stopPolling();
  state.poll = setInterval(() => {
    if (document.visibilityState === 'visible') fn();
  }, ms);
}

const viewDay = () => state.day || state.config.today;

/* Day-picker strip, used by the office views. */
function dayNav(day) {
  const isToday = day === state.config.today;
  return `<div class="periodnav">
    <span class="pn-side pn-left">
      <button class="ghost" data-day="${esc(addDays(day, -1))}">‹ Prev</button>
    </span>
    <strong class="period-title">${esc(dayLabel(day))}
      <span class="tiny muted" style="font-weight:400">${esc(auDate(day))}</span></strong>
    <span class="pn-side pn-right">
      ${isToday ? '' : '<button class="ghost" data-day="today">Today</button>'}
      <button class="ghost" data-day="${esc(addDays(day, 1))}">Next ›</button>
    </span>
  </div>`;
}

function wireDayNav(root, rerender) {
  root.querySelectorAll('[data-day]').forEach((b) => {
    b.onclick = () => {
      const target = b.dataset.day === 'today' ? state.config.today : b.dataset.day;
      state.day = target === state.config.today ? null : target;
      rerender();
    };
  });
}

/** Bottom sheet used for scheduling. Returns a node you fill and wire up. */
function openSheet(html) {
  closeSheet();
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet">${html}</div>`;
  bg.onclick = (e) => { if (e.target === bg) closeSheet(); };
  document.body.append(bg);
  return bg;
}

function closeSheet() {
  document.querySelector('.sheet-bg')?.remove();
}

// Esc closes whatever sheet or dialog is open.
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

/**
 * In-app replacement for window.confirm, so every prompt matches the app's
 * theme instead of dropping a browser chrome dialog on top of it.
 * Resolves false on cancel, true on confirm, or { checked } when `checkbox`
 * is supplied.
 */
function ask({
  title, body = '', confirmText = 'Confirm', cancelText = 'Cancel',
  danger = false, checkbox = null,
}) {
  return new Promise((resolve) => {
    const bg = openSheet(`
      <div class="sheet-head"><strong>${esc(title)}</strong></div>
      <div class="pad stack">
        ${body ? `<p class="dialog-body">${body}</p>` : ''}
        ${checkbox ? `<label class="check-row" data-extra>
            <input type="checkbox">
            <span class="grow">${checkbox}</span>
          </label>` : ''}
        <button class="${danger ? 'destroy' : 'primary'} wide" data-ok>${esc(confirmText)}</button>
        <button class="wide" data-cancel>${esc(cancelText)}</button>
      </div>`);

    const box = bg.querySelector('[data-extra] input');
    if (box) box.onchange = () => box.closest('.check-row').classList.toggle('on', box.checked);

    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      closeSheet();
      resolve(value);
    };

    bg.querySelector('[data-ok]').onclick = () => done(checkbox ? { checked: box.checked } : true);
    bg.querySelector('[data-cancel]').onclick = () => done(false);
    bg.onclick = (e) => { if (e.target === bg) done(false); };
    new MutationObserver(() => { if (!document.body.contains(bg)) done(false); })
      .observe(document.body, { childList: true });
  });
}

/** In-app replacement for window.prompt. Resolves null on cancel. */
function askText({
  title, body = '', label, value = '', confirmText = 'Save', numeric = false, danger = false,
}) {
  return new Promise((resolve) => {
    const bg = openSheet(`
      <div class="sheet-head"><strong>${esc(title)}</strong></div>
      <div class="pad stack">
        ${body ? `<p class="dialog-body">${body}</p>` : ''}
        <label class="field"><span>${esc(label)}</span>
          <input id="askv" value="${esc(value)}" autocomplete="off"
            ${numeric ? 'inputmode="numeric" pattern="\\d*"' : ''}></label>
        <button class="${danger ? 'destroy' : 'primary'} wide" data-ok>${esc(confirmText)}</button>
        <button class="wide" data-cancel>Cancel</button>
      </div>`);

    const input = bg.querySelector('#askv');
    setTimeout(() => input.focus(), 30);

    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      closeSheet();
      resolve(v);
    };

    bg.querySelector('[data-ok]').onclick = () => done(input.value);
    bg.querySelector('[data-cancel]').onclick = () => done(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value); };
    bg.onclick = (e) => { if (e.target === bg) done(null); };
  });
}

/* ------------------------------------------------------------ view: login */

/**
 * "Add to phone" hint shown under the login card. Empty once installed,
 * once dismissed, or on a browser that gives no way to detect either -
 * an unwanted prompt is worse than a missed one.
 */
function installHintHTML() {
  if (localStorage.getItem('bc.installDismissed') === '1') return '';
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return '';

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return `<div class="installhint" id="installhint">
    <span class="grow small">${isIOS
      ? 'Add this to your Home Screen: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.'
      : 'Install this on your phone for one-tap access, full screen, no address bar.'}</span>
    ${isIOS ? '' : '<button class="ghost" id="installbtn" hidden>Install</button>'}
    <button class="ghost" id="installclose" aria-label="Dismiss" title="Dismiss">✕</button>
  </div>`;
}

function wireInstallHint() {
  const hint = $('#installhint');
  if (!hint) return;
  const btn = hint.querySelector('#installbtn');
  if (btn) {
    btn.hidden = !deferredInstall;
    btn.onclick = promptInstall;
  }
  hint.querySelector('#installclose').onclick = () => {
    localStorage.setItem('bc.installDismissed', '1');
    hint.remove();
  };
}

async function renderLogin() {
  bar.hidden = true;
  nav.hidden = true;
  $('#testbar').hidden = !state.config.quickSignin;
  $('#testbar').textContent = 'Test mode — tap any name to sign in, no PIN needed.';
  if (state.config.needsBootstrap) return renderBootstrap();
  if (state.config.quickSignin) return renderPeoplePicker();
  return renderPinPad();
}

/** Test mode: a list of everyone, tap to sign in. */
async function renderPeoplePicker() {
  let people = [];
  try {
    people = (await api('/people')).people;
  } catch {
    return renderPinPad(); // setting flipped off mid-session
  }

  app.innerHTML = `<div class="login card">
    <h2>Who are you?</h2>
    ${people.map((p) => `<button class="person" data-uid="${p.id}">
      ${avatar(p.name, 'lg')}
      <span class="grow">
        <span class="pname" style="display:block">${esc(p.name)}</span>
        <span class="prole">${esc(p.role)}</span>
      </span>
      <span class="muted" aria-hidden="true">›</span>
    </button>`).join('') || '<p class="empty">Nobody has been added yet.</p>'}
    <div class="pad"><button class="wide ghost" id="usepin">Use a PIN instead</button></div>
  </div>
  <p class="err center" id="err"></p>
  ${installHintHTML()}`;

  app.querySelectorAll('[data-uid]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await signIn({ userId: Number(b.dataset.uid) });
      } catch (e) {
        $('#err').textContent = e.message;
        b.disabled = false;
      }
    };
  });
  $('#usepin').onclick = renderPinPad;
  wireInstallHint();
}

async function signIn(body) {
  const { token, user } = await api('/login', { method: 'POST', body });
  state.token = token;
  state.user = user;
  localStorage.setItem('bc.token', token);
  localStorage.setItem('bc.user', JSON.stringify(user));
  await render();
}

function renderPinPad() {
  app.innerHTML = `<div class="login card">
    <h2>Basecamp Cleaning</h2>
    <div class="pad stack center">
      <p class="muted small">Enter your PIN</p>
      <div class="pindots" id="dots"></div>
      <p class="err" id="err"></p>
      <div class="pinpad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join('')}
        <button data-k="del">⌫</button>
        <button data-k="0">0</button>
        <button class="primary" data-k="go">→</button>
      </div>
      ${state.config.quickSignin
        ? '<button class="wide ghost" id="uselist">← Pick from the list instead</button>'
        : ''}
    </div>
  </div>
  ${installHintHTML()}`;

  $('#uselist')?.addEventListener('click', renderPeoplePicker);
  wireInstallHint();

  let pin = '';
  const dots = $('#dots');
  const err = $('#err');
  const draw = () => { dots.textContent = '•'.repeat(pin.length); };

  async function submit() {
    if (pin.length < 4) return;
    err.textContent = '';
    try {
      await signIn({ pin });
    } catch (e) {
      pin = '';
      draw();
      err.textContent = e.message;
    }
  }

  app.querySelectorAll('[data-k]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.k;
      if (k === 'del') pin = pin.slice(0, -1);
      else if (k === 'go') return submit();
      else if (pin.length < 8) pin += k;
      draw();
    };
  });

  addEventListener('keydown', function onKey(e) {
    if (!document.body.contains(dots)) return removeEventListener('keydown', onKey);
    if (/^\d$/.test(e.key) && pin.length < 8) { pin += e.key; draw(); }
    else if (e.key === 'Backspace') { pin = pin.slice(0, -1); draw(); }
    else if (e.key === 'Enter') submit();
  });
}

function renderBootstrap() {
  app.innerHTML = `<div class="login card">
    <h2>First-time setup</h2>
    <div class="pad stack">
      <p class="small muted">Create the administrator account. This screen
        disappears as soon as the first account exists.</p>
      <label class="field"><span>Your name</span><input id="n" autocomplete="name"></label>
      <label class="field"><span>Choose a PIN (4-8 digits)</span>
        <input id="p" inputmode="numeric" pattern="\\d*" autocomplete="new-password"></label>
      <p class="err" id="err"></p>
      <button class="primary wide" id="go">Create admin account</button>
    </div>
  </div>`;

  $('#go').onclick = async () => {
    try {
      await api('/bootstrap', {
        method: 'POST',
        body: { name: $('#n').value, pin: $('#p').value },
      });
      state.config.needsBootstrap = false;
      toast('Account created — now sign in with your PIN');
      render();
    } catch (e) {
      $('#err').textContent = e.message;
    }
  };
}

/* ------------------------------------------------- view: office overview */

async function renderOverview() {
  const day = viewDay();
  const { buildings } = await api(`/overview?day=${day}`);
  chrome({ title: 'Overview', section: '', wide: true });

  // The API returns scheduled buildings first, already in priority order.
  const runSheet = buildings.filter((b) => b.scheduled);
  const rest = buildings.filter((b) => !b.scheduled);

  // Progress counts only what is actually on today's plan. Totalling every
  // task in the park gives "0 of 1100", which says nothing about the day.
  const totals = runSheet.reduce((acc, b) => ({
    done: acc.done + b.done,
    total: acc.total + b.total,
    signed: acc.signed + (b.completed_at ? 1 : 0),
  }), { done: 0, total: 0, signed: 0 });

  // Open issues stay camp-wide - a broken cistern matters whether or not that
  // building is on today's list.
  totals.issues = buildings.reduce((n, b) => n + b.open_issues, 0);

  const pct = totals.total ? Math.round((totals.done / totals.total) * 100) : 0;
  const outstanding = runSheet.filter((b) => !b.completed_at).length;
  const unassigned = runSheet.filter((b) => !b.assignees.length);
  const stale = rest.filter((b) => staleDays(b, day) >= 7);

  app.innerHTML = `
    <div class="card"><div class="pad">${dayNav(day)}</div></div>

    <div class="card">
      <div class="stats">
        <div class="stat"><b>${pct}%</b><span>of today's tasks</span></div>
        <div class="stat"><b>${totals.signed}/${runSheet.length}</b>
          <span>buildings signed off</span></div>
        <div class="stat"><b style="color:var(--${outstanding ? 'warn' : 'done'})">${outstanding}</b>
          <span>still to do</span></div>
        <div class="stat"><b style="color:var(--${totals.issues ? 'warn' : 'muted'})">${totals.issues}</b>
          <span>open issues</span></div>
      </div>
      <div class="pad" style="padding-top:12px">
        <div class="meter ${pct === 100 ? 'full' : ''}"><i style="width:${pct}%"></i></div>
        <div class="tiny muted center" style="margin-top:6px">
          ${runSheet.length
            ? `${totals.done} of ${totals.total} tasks across
               ${runSheet.length} building${runSheet.length === 1 ? '' : 's'} scheduled
               ${dayLabel(day) === 'Today' ? 'today' : 'that day'}`
            : `Nothing scheduled — ${buildings.length} buildings in the park`}</div>
      </div>
    </div>

    ${unassigned.length ? `<div class="card">
      <div class="pad small" style="background:var(--warn-bg);color:var(--warn)">
        <strong>Nobody assigned to
        ${unassigned.map((b) => esc(b.name)).join(', ')}.</strong>
        Open <strong>Schedule</strong> to put a cleaner on ${unassigned.length > 1 ? 'them' : 'it'}.
      </div></div>` : ''}

    <div class="cols">
      <div class="card">
        <h2>Run sheet — ${runSheet.length ? `${outstanding} of ${runSheet.length} left`
          : 'nothing scheduled'}</h2>
        ${runSheet.length
          ? runSheet.map(overviewTile).join('')
          : `<div class="empty"><b>Nothing scheduled</b>
             Open <strong>Schedule</strong> to plan the week.</div>`}
      </div>

      <div class="card">
        <h2>Not scheduled ${dayLabel(day).toLowerCase() === 'today' ? 'today' : 'this day'}</h2>
        ${rest.length
          ? rest.map(overviewTile).join('')
          : '<div class="empty">Every building is on the run sheet.</div>'}
      </div>
    </div>

    ${stale.length ? `<div class="card"><div class="pad small muted">
      Not cleaned in a week or more:
      <strong>${stale.map((b) => esc(b.name)).join(', ')}</strong>.
    </div></div>` : ''}`;

  wireTiles();
  wireDayNav(app, renderOverview);
  poll(renderOverview, 30000);
}

/**
 * Days since this building was last signed off. Returns 0 for a building that
 * has never been signed off, so a brand new camp doesn't get flagged on day
 * one - each tile already says "never signed off" on its own.
 */
function staleDays(b, day) {
  if (!b.lastCleaned) return 0;
  return Math.round((asDate(day) - asDate(b.lastCleaned)) / 86400000);
}

function overviewTile(b) {
  const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
  const status = b.completed_at
    ? `<span class="pill done">Signed off ${esc(time(b.completed_at))}</span>`
    : b.done
      ? '<span class="pill open">In progress</span>'
      : b.scheduled
        ? '<span class="pill late">Not started</span>'
        : '<span class="pill idle">Not started</span>';

  const meta = [
    b.assignees.length
      ? `for ${b.assignees.map((a) => esc(firstName(a.name))).join(', ')}`
      : b.scheduled ? '<span style="color:var(--warn)">unassigned</span>' : null,
    b.crew.length ? `worked by ${b.crew.map((c) => esc(firstName(c))).join(', ')}` : null,
    b.last_at ? `last ${esc(time(b.last_at))}` : null,
    b.open_issues ? `${b.open_issues} open issue${b.open_issues > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' · ');

  // Only the green 'done' edge earns its place - the status pill already
  // carries 'outstanding', and every run-sheet row is outstanding by definition.
  const edge = b.completed_at ? ' finished' : '';

  return `<button class="tile${edge}"
      ${canDrillIn() ? `data-b="${b.id}"` : 'disabled'}>
    <div class="spread">
      <span class="row" style="gap:8px;min-width:0">
        ${b.scheduled ? `<span class="prio">${b.priority}</span>` : ''}
        <span class="name">${esc(b.name)}</span>
        ${b.assignees.length ? avatarStack(b.assignees) : ''}
      </span>
      ${status}
    </div>
    <div class="meter ${pct === 100 ? 'full' : ''}"><i style="width:${pct}%"></i></div>
    <div class="spread small muted" style="margin-top:6px">
      <span class="grow">${meta || 'not scheduled'}</span>
      <span>${b.done}/${b.total}</span>
    </div>
    <div class="tiny muted" style="margin-top:2px">
      ${b.grp && b.grp !== b.name ? `${esc(b.grp)} · ` : ''}${
        esc(sinceLabel(b.lastCleaned, state.config.today))}${
        b.note ? ` · ${esc(b.note)}` : ''}</div>
  </button>`;
}

/** True when this user is allowed to open an individual building's checklist. */
const canDrillIn = () => state.user.role !== 'office' || !state.config.rollupOnly;

function wireTiles() {
  app.querySelectorAll('[data-b]').forEach((el) => {
    el.onclick = () => { location.hash = `#/b/${el.dataset.b}`; };
  });
  app.querySelectorAll('[data-go]').forEach((el) => {
    el.onclick = () => { location.hash = el.dataset.go; };
  });
}

/* ------------------------------------------------------ view: cleaner home */

async function renderCleanerHome() {
  const today = state.config.today;
  const { buildings } = await api(`/overview?day=${today}`);
  chrome({ title: `Hi ${firstName(state.user.name)}`, section: '' });

  const mine = buildings.filter((b) =>
    b.assignees.some((a) => a.id === state.user.id));
  const otherScheduled = buildings.filter((b) => b.scheduled && !mine.includes(b));
  const rest = buildings.filter((b) => !b.scheduled);

  const doneCount = mine.filter((b) => b.completed_at).length;

  app.innerHTML = `
    ${mine.length ? `<div class="card">
      <h2>Your buildings today — ${doneCount}/${mine.length} done</h2>
      ${mine.map((b) => jobTile(b, true)).join('')}
    </div>` : `<div class="card"><div class="empty">
      <b>Nothing assigned to you today</b>
      Pick any building below and start whenever you like.
    </div></div>`}

    ${otherScheduled.length ? `<div class="card">
      <h2>Also scheduled today</h2>
      ${otherScheduled.map(jobTile).join('')}
    </div>` : ''}

    ${rest.length ? `<div class="card">
      <h2>Other buildings</h2>
      ${rest.map(jobTile).join('')}
    </div>` : ''}

    <p class="tiny muted center">
      Office ${esc(state.config.officePhone)} · Maintenance ${esc(state.config.maintenancePhone)}
    </p>`;

  wireTiles();
  poll(renderCleanerHome, 60000);
}

function jobTile(b, isMine = false) {
  const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
  const status = b.completed_at
    ? `<span class="pill done">Done ${esc(time(b.completed_at))}</span>`
    : b.done ? '<span class="pill open">In progress</span>'
             : '<span class="pill idle">Not started</span>';

  // On your own jobs, name the other people on it - not yourself.
  const others = isMine
    ? b.assignees.filter((a) => a.id !== state.user.id)
    : b.assignees;
  const who = others.length
    ? `${isMine ? 'with' : 'for'} ${others.map((a) => esc(firstName(a.name))).join(', ')}`
    : '';

  return `<button class="tile${b.completed_at ? ' finished' : ''}" data-b="${b.id}">
    <div class="spread">
      <span class="row" style="gap:8px;min-width:0">
        ${b.scheduled ? `<span class="prio">${b.priority}</span>` : ''}
        <span class="name">${esc(b.name)}</span>
        ${others.length ? avatarStack(others) : ''}
      </span>
      ${status}
    </div>
    <div class="meter ${pct === 100 ? 'full' : ''}"><i style="width:${pct}%"></i></div>
    <div class="spread small muted" style="margin-top:6px">
      <span class="grow">${who}${b.note ? `${who ? ' · ' : ''}${esc(b.note)}` : ''}</span>
      <span>${b.done}/${b.total}</span>
    </div>
  </button>`;
}

/* --------------------------------------------------- view: schedule grid */

async function renderSchedule() {
  const from = state.weekFrom || startOfWeek(state.config.today);
  state.weekFrom = from;

  const data = await api(`/schedule?from=${from}&days=7`);
  chrome({ title: 'Schedule', section: 'schedule', wide: true });
  const canEdit = data.canEdit;

  const isWeekend = (d) => [0, 6].includes(asDate(d).getUTCDay());

  const cell = (b, day) => {
    const c = data.cells[`${b.id}:${day}`] ?? {};
    const scheduled = c.priority != null;
    const pct = b.total && c.done ? Math.round((c.done / b.total) * 100) : 0;
    const classes = [
      'cell',
      scheduled ? 'on' : '',
      c.completedAt ? 'complete' : '',
      scheduled && !c.assignees?.length && !c.completedAt ? 'unassigned' : '',
    ].filter(Boolean).join(' ');

    let inner;
    if (scheduled || c.done || c.completedAt) {
      inner = `<div class="cell-top">
          ${scheduled ? `<span class="prio">${c.priority}</span>` : ''}
          ${c.assignees?.length ? avatarStack(c.assignees) : ''}
          ${c.completedAt ? '<span class="tickmark">✓</span>' : ''}
        </div>
        ${c.assignees?.length
          ? `<div class="names">${c.assignees.map((a) => esc(firstName(a.name))).join(', ')}</div>`
          : scheduled ? '<div class="warn-dot">unassigned</div>' : ''}
        ${c.done ? `<div class="mini ${pct === 100 ? 'full' : ''}"><i style="width:${pct}%"></i></div>` : ''}`;
    } else {
      inner = canEdit ? '<span class="plus">+</span>' : '';
    }

    const tdCls = [day === data.today ? 'today-col' : '', isWeekend(day) ? 'weekend' : '']
      .filter(Boolean).join(' ');
    return `<td class="${tdCls}">
      <button class="${classes}" data-cell="${b.id}|${day}"
        title="${esc(b.name)} — ${esc(dayLabel(day))}"
        ${canEdit ? '' : 'disabled'}>${inner}</button></td>`;
  };

  app.innerHTML = `
    <div class="card"><div class="pad">
      <div class="periodnav">
        <span class="pn-side pn-left">
          <button class="ghost" data-week="${esc(addDays(from, -7))}">‹ Prev</button>
        </span>
        <strong class="period-title">
          ${esc(dayOfMonth(from))} – ${esc(dayOfMonth(addDays(from, 6)))}</strong>
        <span class="pn-side pn-right">
          <button class="ghost" data-week="${esc(startOfWeek(state.config.today))}">This week</button>
          <button class="ghost" data-week="${esc(addDays(from, 7))}">Next ›</button>
        </span>
      </div>
    </div></div>

    <div class="card">
      <div class="grid-wrap">
        <table class="sched">
          <thead><tr>
            <th class="corner">Building</th>
            ${data.days.map((d) => {
              const cls = [d === data.today ? 'is-today' : '', isWeekend(d) ? 'weekend' : '']
                .filter(Boolean).join(' ');
              return `<th class="${cls}">${esc(weekdayShort(d))}<small>${esc(dayOfMonth(d))}</small></th>`;
            }).join('')}
          </tr></thead>
          <tbody>
            ${data.buildings.map((b) => {
              const weekCount = data.days
                .filter((d) => data.cells[`${b.id}:${d}`]?.priority != null).length;
              return `<tr>
                <th class="rowhead">${esc(b.name)}
                  <small>${b.grp && b.grp !== b.name ? `${esc(b.grp)} · ` : ''}${weekCount
                    ? `${weekCount} this week` : 'not scheduled'}</small></th>
                ${data.days.map((d) => cell(b, d)).join('')}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="legend">
        <span><i style="background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent)"></i>Scheduled</span>
        <span><i style="background:var(--done-bg);box-shadow:inset 0 0 0 1px var(--done)"></i>Signed off</span>
        <span><i style="background:var(--warn)"></i>Nobody assigned</span>
      </div>
    </div>

    <p class="tiny muted center">
      ${canEdit
        ? 'Tap any square to schedule that building, choose who cleans it, and set its order.'
        : 'This is the roster. The office sets it — tap a building on your home screen to start cleaning.'}
    </p>`;

  app.querySelectorAll('[data-week]').forEach((b) => {
    b.onclick = () => { state.weekFrom = b.dataset.week; renderSchedule(); };
  });

  if (canEdit) {
    app.querySelectorAll('[data-cell]').forEach((b) => {
      b.onclick = () => {
        const [bid, day] = b.dataset.cell.split('|');
        openScheduleEditor(data, Number(bid), day);
      };
    });
  }

  poll(renderSchedule, 45000);
}

/** Monday of the week containing `day`. */
function startOfWeek(day) {
  const d = asDate(day);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(day, -dow);
}

async function openScheduleEditor(data, buildingId, day) {
  const building = data.buildings.find((b) => b.id === buildingId);
  const cell = data.cells[`${buildingId}:${day}`] ?? {};
  const scheduled = cell.priority != null;

  if (!state.cleaners) {
    try {
      state.cleaners = (await api('/cleaners')).cleaners;
    } catch (e) {
      return toast(e.message, true);
    }
  }

  const picked = new Set((cell.assignees ?? []).map((a) => a.id));

  const sheet = openSheet(`
    <div class="sheet-head">
      <div>
        <strong>${esc(building.name)}</strong>
        <div class="small muted">${esc(dayLabel(day))} · ${esc(dayOfMonth(day))}</div>
      </div>
      ${scheduled ? '<span class="pill open">Scheduled</span>' : ''}
    </div>
    <div class="pad stack">
      <label class="field"><span>Order of priority — 1 gets done first</span>
        <input id="prio" type="number" min="1" max="99" inputmode="numeric"
          value="${scheduled ? cell.priority : nextPriority(data, day)}"></label>

      <div>
        <span class="small muted" style="display:block;margin-bottom:6px;font-weight:600">
          Who is cleaning it</span>
        <div class="check-list">
          ${[...state.cleaners]
            .sort((x, y) => (worksOn(y, day) ? 1 : 0) - (worksOn(x, day) ? 1 : 0))
            .map((c) => {
              const slot = Array.isArray(c.availability) ? c.availability[weekdayIndex(day)] : null;
              const note = slot
                ? `<span class="tiny muted" style="display:block">available ${slot.from}–${slot.to}</span>`
                : `<span class="tiny" style="display:block;color:var(--warn)">
                    doesn't usually work ${esc(DAY_NAMES[weekdayIndex(day)])}</span>`;
              return `<label class="check-row ${picked.has(c.id) ? 'on' : ''}" data-pick="${c.id}">
                <input type="checkbox" ${picked.has(c.id) ? 'checked' : ''}>
                ${avatar(c.name)}
                <span class="grow">${esc(c.name)} ${note}</span>
                <span class="tiny muted">${esc(c.role)}</span>
              </label>`;
            }).join('')
            || '<p class="small muted">No cleaners yet — add them under People.</p>'}
        </div>
        <p class="tiny muted" style="margin:7px 0 0">
          More than one person can be put on the same building. People who don't normally
          work that day are listed last, but you can still pick them.</p>
      </div>

      <label class="field"><span>Note for this job (optional)</span>
        <input id="note" maxlength="200" value="${esc(cell.note ?? '')}"
          placeholder="Group arriving 2pm — finish by 1pm"></label>

      <p class="err" id="err"></p>
      <button class="primary wide" id="save">${scheduled ? 'Save changes' : 'Add to schedule'}</button>
      ${scheduled ? '<button class="wide danger" id="clear">Remove from schedule</button>' : ''}
      <button class="wide" id="cancel">Cancel</button>
    </div>`);

  // The <label> wraps the checkbox, so the whole row is already a hit target.
  // Just mirror the resulting state into the class - flipping it by hand here
  // would undo the browser's own toggle.
  sheet.querySelectorAll('[data-pick]').forEach((row) => {
    const box = row.querySelector('input');
    box.onchange = () => row.classList.toggle('on', box.checked);
  });

  sheet.querySelector('#cancel').onclick = closeSheet;

  sheet.querySelector('#save').onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      const assignees = [...sheet.querySelectorAll('[data-pick]')]
        .filter((r) => r.querySelector('input').checked)
        .map((r) => Number(r.dataset.pick));
      await api('/schedule', {
        method: 'POST',
        body: {
          buildingId, day,
          priority: Number(sheet.querySelector('#prio').value) || 1,
          note: sheet.querySelector('#note').value,
          assignees,
        },
      });
      closeSheet();
      toast('Schedule updated');
      renderSchedule();
    } catch (e) {
      sheet.querySelector('#err').textContent = e.message;
      ev.currentTarget.disabled = false;
    }
  };

  sheet.querySelector('#clear')?.addEventListener('click', async () => {
    const workDone = (cell.done ?? 0) > 0 || Boolean(cell.completedAt);
    const res = await ask({
      title: 'Remove from schedule?',
      body: workDone
        ? `<strong>${esc(building.name)}</strong> already has
           <strong>${cell.done ?? 0}</strong> item${(cell.done ?? 0) === 1 ? '' : 's'} ticked
           for ${esc(dayLabel(day).toLowerCase())}${cell.completedAt ? ' and is signed off' : ''}.
           Taking it off the plan leaves that record in place.`
        : `<strong>${esc(building.name)}</strong> will come off the plan for
           ${esc(dayLabel(day).toLowerCase())}.`,
      confirmText: 'Remove',
      danger: true,
      checkbox: workDone
        ? `Also wipe that day's ticks and sign-off
           <span class="tiny muted" style="display:block">The building goes back to 0 done.</span>`
        : null,
    });
    if (!res) return;

    await api('/schedule/clear', {
      method: 'POST',
      body: { buildingId, day, clearProgress: Boolean(res.checked) },
    });
    closeSheet();
    toast(res.checked ? 'Removed and progress cleared' : 'Removed from schedule');
    renderSchedule();
  });
}

/** Suggests the next free priority number for a day. */
function nextPriority(data, day) {
  const used = data.buildings
    .map((b) => data.cells[`${b.id}:${day}`]?.priority)
    .filter((p) => p != null);
  return used.length ? Math.max(...used) + 1 : 1;
}

/* ---------------------------------------------- view: building checklist */

async function renderBuilding(id) {
  const day = state.user.role === 'cleaner' ? state.config.today : viewDay();

  let data;
  try {
    data = await api(`/building?id=${id}&day=${day}`);
  } catch (e) {
    chrome({ title: 'Not available', back: true });
    app.innerHTML = `<div class="card pad"><p class="err">${esc(e.message)}</p></div>`;
    return;
  }

  state.building = data;
  chrome({ title: data.building.name, back: true });
  const locked = data.readOnly;

  app.innerHTML = `
    <div class="card">
      <div class="pad">
        ${state.user.role !== 'cleaner' ? `${dayNav(day)}<div style="height:10px"></div>` : ''}
        <div class="spread">
          <strong id="count"></strong>
          <span class="small muted">${esc(dayLabel(day))}</span>
        </div>
        <div class="meter" id="meter"><i></i></div>
        <p class="small" id="signoff" style="color:var(--done);margin:10px 0 0"></p>
      </div>
    </div>

    <div id="areas">${data.areas.map(areaCard).join('')}</div>

    <div class="card" id="issues" hidden><h2>Open issues here</h2><div id="issuelist"></div></div>

    ${locked ? '<p class="small muted center">Read-only — only cleaners can tick items.</p>' : `
      <div class="stack">
        <button class="wide" id="report">Report maintenance or lost property</button>
        <button class="wide primary" id="complete"></button>
      </div>`}`;

  paintBuilding(data, locked);

  if (state.user.role !== 'cleaner') wireDayNav(app, () => renderBuilding(id));

  if (!locked) {
    app.querySelectorAll('.task').forEach((el) => {
      el.onclick = () => toggleTask(el, id, day);
    });
    $('#report').onclick = () => renderReport(data);
    $('#complete').onclick = async () => {
      const { done, total } = counts(state.building);
      const undo = Boolean(state.building.completed);
      const left = total - done;

      const go = await ask({
        title: undo ? 'Reopen this building?' : `Finished ${data.building.name}?`,
        body: undo
          ? 'It goes back to in-progress and the office will see it as unfinished.'
          : left
            ? `<strong>${left}</strong> item${left === 1 ? ' is' : 's are'} still unticked.
               You can still mark it done — the office sees ${done} of ${total} ticked.`
            : `All <strong>${total}</strong> items are ticked. The office will see it
               as finished.`,
        confirmText: undo ? 'Reopen' : 'Yes, all done',
      });
      if (!go) return;

      try {
        const res = await api('/building/complete', {
          method: 'POST', body: { buildingId: id, day, undo },
        });
        if (undo) {
          state.building.completed = res.completed;
          paintBuilding(state.building, locked);
          toast('Building reopened');
          return;
        }
        // Finishing a building ends the job, so hand them back their list
        // rather than leaving them on a checklist they are done with.
        toast(`${data.building.name} marked complete`);
        location.hash = '#/';
      } catch (e) {
        toast(e.message, true);
      }
    };
  }

  // Frequent enough that two cleaners in the same room see each other's ticks.
  poll(() => refreshBuilding(id, day, locked), 20000);
}

const counts = (data) => {
  const tasks = data.areas.flatMap((a) => a.tasks);
  return { done: tasks.filter((t) => t.done).length, total: tasks.length };
};

function areaCard(area) {
  const done = area.tasks.filter((t) => t.done).length;
  return `<div class="card">
    <div class="area-head">
      <span>${esc(area.name)}</span>
      <span class="small muted" data-areacount="${area.id}">${done}/${area.tasks.length}</span>
    </div>
    ${area.tasks.map((t) => `
      <button class="task${t.done ? ' is-done' : ''}" data-t="${t.id}" data-done="${t.done ? 1 : 0}">
        <span class="box">✓</span>
        <span class="grow">
          <span class="item">${esc(t.item)}</span>
          <span class="desc" style="display:block">${esc(t.description)}</span>
          <span class="who">${t.done && t.by ? `${esc(t.by)} · ${esc(time(t.at))}` : ''}</span>
        </span>
      </button>`).join('')}
  </div>`;
}

/** Updates the summary, sign-off line and issue list from `data`, in place. */
function paintBuilding(data, locked) {
  const { done, total } = counts(data);
  const pct = total ? Math.round((done / total) * 100) : 0;

  $('#count').textContent = `${done} of ${total} done`;
  const meter = $('#meter');
  meter.classList.toggle('full', pct === 100);
  meter.firstElementChild.style.width = `${pct}%`;

  $('#signoff').textContent = data.completed
    ? `✓ Signed off by ${data.completed.completed_by} at ${time(data.completed.completed_at)}`
    : '';

  for (const area of data.areas) {
    const cell = app.querySelector(`[data-areacount="${area.id}"]`);
    if (cell) {
      cell.textContent = `${area.tasks.filter((t) => t.done).length}/${area.tasks.length}`;
    }
  }

  const issues = $('#issues');
  issues.hidden = !data.issues.length;
  $('#issuelist').innerHTML = data.issues.map((i) => `<div class="list-item small">
      <strong>${i.kind === 'lost_property' ? 'Lost property' : 'Maintenance'}</strong> —
      ${esc(i.detail)}
      <div class="tiny muted">${esc(i.reported_by)} · ${esc(time(i.reported_at))}</div>
    </div>`).join('');

  if (!locked) {
    $('#complete').textContent = data.completed
      ? 'Reopen this building'
      : 'Done — mark this building complete';
  }
}

/** Polling refresh: patch the DOM rather than rebuild it, so nobody's scroll
    position or half-finished tap gets thrown away mid-shift. */
async function refreshBuilding(id, day, locked) {
  let data;
  try {
    data = await api(`/building?id=${id}&day=${day}`);
  } catch {
    return; // transient - the next tick will catch up
  }

  const before = state.building.areas.flatMap((a) => a.tasks).map((t) => t.id).join();
  const after = data.areas.flatMap((a) => a.tasks).map((t) => t.id).join();
  if (before !== after) return renderBuilding(id); // checklist itself changed

  state.building = data;
  for (const task of data.areas.flatMap((a) => a.tasks)) {
    const el = app.querySelector(`.task[data-t="${task.id}"]`);
    if (!el) continue;
    el.classList.toggle('is-done', task.done);
    el.dataset.done = task.done ? '1' : '0';
    el.querySelector('.who').textContent =
      task.done && task.by ? `${task.by} · ${time(task.at)}` : '';
  }
  paintBuilding(data, locked);
}

async function toggleTask(el, buildingId, day) {
  const taskId = Number(el.dataset.t);
  const next = el.dataset.done !== '1';
  const task = state.building.areas.flatMap((a) => a.tasks).find((t) => t.id === taskId);

  // Flip immediately so the tap feels instant, then reconcile with the server.
  el.classList.toggle('is-done', next);
  el.dataset.done = next ? '1' : '0';
  if (task) task.done = next;
  paintBuilding(state.building, false);

  try {
    const res = await api('/task', { method: 'POST', body: { taskId, done: next, day } });
    if (task) { task.by = res.by; task.at = res.at; }
    el.querySelector('.who').textContent = next ? `${res.by} · ${time(res.at)}` : '';
  } catch (e) {
    el.classList.toggle('is-done', !next);
    el.dataset.done = next ? '0' : '1';
    if (task) task.done = !next;
    paintBuilding(state.building, false);
    toast(e.message, true);
  }
}

/* ------------------------------------------------------- view: reporting */

function renderReport(data) {
  stopPolling();
  chrome({ title: 'Report', back: true });

  app.innerHTML = `<div class="card">
    <h2>${esc(data.building.name)}</h2>
    <div class="pad stack">
      <label class="field"><span>Type</span>
        <select id="kind">
          <option value="maintenance">Maintenance or damage</option>
          <option value="lost_property">Lost property</option>
        </select></label>
      <label class="field"><span>Where (optional)</span>
        <select id="area">
          <option value="">Not specific</option>
          ${data.areas.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}
        </select></label>
      <label class="field"><span>What's wrong / what did you find?</span>
        <textarea id="detail" placeholder="Broken cistern in the left cubicle…"></textarea></label>
      ${state.config.photos ? `<label class="field"><span>Photo (optional)</span>
        <input type="file" id="photo" accept="image/*" capture="environment"></label>
        <img class="thumb" id="preview" hidden alt="">` : ''}
      <p class="err" id="err"></p>
      <button class="primary wide" id="send">Send report</button>
      <button class="wide" id="cancel">Cancel</button>
    </div>
  </div>`;

  let photoBlob = null;
  const photoInput = $('#photo');
  if (photoInput) {
    photoInput.onchange = async () => {
      const file = photoInput.files[0];
      if (!file) { photoBlob = null; return; }
      photoBlob = await shrinkImage(file);
      const preview = $('#preview');
      preview.src = URL.createObjectURL(photoBlob);
      preview.hidden = false;
    };
  }

  $('#cancel').onclick = () => renderBuilding(data.building.id);

  $('#send').onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      let photoKey = null;
      if (photoBlob) {
        const up = await api('/photo', {
          method: 'POST', raw: true, body: photoBlob, contentType: 'image/jpeg',
        });
        photoKey = up.key;
      }
      await api('/maintenance', {
        method: 'POST',
        body: {
          buildingId: data.building.id,
          areaId: $('#area').value || null,
          kind: $('#kind').value,
          detail: $('#detail').value,
          photoKey,
        },
      });
      toast('Report sent to the office');
      renderBuilding(data.building.id);
    } catch (e) {
      $('#err').textContent = e.message;
      btn.disabled = false;
    }
  };
}

/** Phone photos run to several MB; resize to 1280px JPEG so uploads are
    quick on a weak mobile signal. */
async function shrinkImage(file, max = 1280, quality = 0.75) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/* ----------------------------------------------------- view: issues list */

async function renderIssues(status = 'open') {
  const { items } = await api(`/maintenance?status=${status}`);
  chrome({ title: 'Issues', section: 'issues' });
  const canResolve = state.user.role !== 'cleaner';

  app.innerHTML = `
    <div class="tabs">
      <button data-s="open" aria-current="${status === 'open'}">Open</button>
      <button data-s="resolved" aria-current="${status === 'resolved'}">Resolved</button>
    </div>
    <div class="card">
      ${items.length ? items.map((i) => `
        <div class="list-item">
          <div class="spread wrap">
            <strong>${esc(i.building)}${i.area ? ` — ${esc(i.area)}` : ''}</strong>
            <span class="pill ${i.kind === 'lost_property' ? 'idle' : 'open'}">
              ${i.kind === 'lost_property' ? 'Lost property' : 'Maintenance'}</span>
          </div>
          <div style="margin:4px 0">${esc(i.detail)}</div>
          ${i.photo_key ? `<img class="thumb" hidden alt="Reported problem"
             data-photo="${esc(i.photo_key)}">` : ''}
          <div class="tiny muted">Reported by ${esc(i.reported_by)} on ${esc(auDate(i.day))}
            ${i.resolved_at ? ` · resolved by ${esc(i.resolved_by)}` : ''}</div>
          ${canResolve ? `<div style="margin-top:8px">
            <button class="ghost" data-r="${i.id}" data-reopen="${status === 'resolved'}">
              ${status === 'resolved' ? 'Reopen' : 'Mark resolved'}</button></div>` : ''}
        </div>`).join('')
        : `<div class="empty"><b>Nothing ${status === 'open' ? 'outstanding' : 'here yet'}</b>
           ${status === 'open' ? 'Every reported problem has been dealt with.' : ''}</div>`}
    </div>`;

  app.querySelectorAll('[data-photo]').forEach((img) => loadPhoto(img, img.dataset.photo));

  app.querySelectorAll('[data-s]').forEach((b) => {
    b.onclick = () => renderIssues(b.dataset.s);
  });
  app.querySelectorAll('[data-r]').forEach((b) => {
    b.onclick = async () => {
      await api('/maintenance/resolve', {
        method: 'POST',
        body: { id: Number(b.dataset.r), reopen: b.dataset.reopen === 'true' },
      });
      renderIssues(status);
    };
  });
}

/* ---------------------------------------------------- view: activity log */

const VERB = {
  done: 'ticked', undone: 'un-ticked', completed: 'signed off',
  reopened: 'reopened', issue: 'reported', lost_property: 'logged lost property',
  scheduled: 'scheduled',
};

async function renderHistory() {
  const day = viewDay();
  const { activity } = await api(`/activity?day=${day}`);
  chrome({ title: 'Activity', section: 'history' });

  app.innerHTML = `
    <div class="card"><div class="pad">${dayNav(day)}</div></div>
    <div class="card">
      ${activity.length ? activity.map((a) => `
        <div class="list-item small">
          <div><strong>${esc(a.user_name)}</strong> ${esc(VERB[a.kind] || a.kind)}
            — ${esc(a.detail)}</div>
          <div class="tiny muted">${esc(a.building)} · ${esc(time(a.created_at))}</div>
        </div>`).join('')
        : '<div class="empty">No activity on this day.</div>'}
    </div>
    <button class="wide" id="csv">Download CSV for this day</button>`;

  wireDayNav(app, renderHistory);
  $('#csv').onclick = async () => {
    try {
      const res = await request(`/report?from=${day}&to=${day}`);
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement('a'),
        { href: url, download: `cleaning-${auDate(day)}.csv` }).click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/* ------------------------------------ availability helpers (admin editor) */

const DEFAULT_SLOT = { from: '08:00', to: '16:00' };

/** `days`: 7 entries, each null (not working) or { from, to }. */
function dayToggles(days) {
  return DAY_NAMES.map((name, i) => {
    const slot = days[i];
    const on = Boolean(slot);
    const from = slot?.from ?? DEFAULT_SLOT.from;
    const to = slot?.to ?? DEFAULT_SLOT.to;
    return `<div class="check-row daytoggle ${on ? 'on' : ''}" data-day-toggle="${i}">
      <label class="row">
        <input type="checkbox" ${on ? 'checked' : ''}>
        <span class="grow">${name}</span>
      </label>
      <span class="daytimes" ${on ? '' : 'hidden'}>
        <input type="time" class="dayfrom" value="${from}" step="900">
        <span class="muted">–</span>
        <input type="time" class="dayto" value="${to}" step="900">
      </span>
    </div>`;
  }).join('');
}

function wireDayToggles(root) {
  root.querySelectorAll('[data-day-toggle]').forEach((row) => {
    const box = row.querySelector('input[type="checkbox"]');
    const times = row.querySelector('.daytimes');
    box.onchange = () => {
      row.classList.toggle('on', box.checked);
      times.hidden = !box.checked;
    };
  });
}

/** "Mon-Fri, 8am-4pm" style summary. Groups identical time ranges together. */
function daysSummary(days) {
  if (!Array.isArray(days)) return 'any time';
  const on = days.map((s, i) => (s ? { day: DAY_NAMES[i], ...s } : null)).filter(Boolean);
  if (!on.length) return 'no days set';

  const hhmm = (t) => t.replace(/^0/, '').replace(':00', '') + (t < '12:00' ? 'am' : 'pm');
  const groups = new Map();
  for (const s of on) {
    const key = `${s.from}-${s.to}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s.day);
  }
  return [...groups.entries()]
    .map(([key, ds]) => {
      const [from, to] = key.split('-');
      return `${ds.join(', ')} ${hhmm(from)}–${hhmm(to)}`;
    })
    .join(' · ');
}

/** Reads the sheet back into the 7-slot shape the API expects. */
const readDayToggles = (root) => [...root.querySelectorAll('[data-day-toggle]')]
  .map((row) => {
    const box = row.querySelector('input[type="checkbox"]');
    if (!box.checked) return null;
    return {
      from: row.querySelector('.dayfrom').value || DEFAULT_SLOT.from,
      to: row.querySelector('.dayto').value || DEFAULT_SLOT.to,
    };
  });

/* ------------------------------------------ view: checklist editor (admin) */

async function renderChecklistAdmin() {
  const data = await api('/admin/checklist');
  chrome({ title: 'Checklists', section: 'buildings', wide: true });
  const areasFor = (id) => data.areas.filter((a) => a.building_id === id);

  // Grouped by building.grp, in the order groups first appear - matches the
  // schedule grid's ordering so the two screens read the same way. With 20+
  // buildings a flat list was a wall of text; headings make it scannable.
  const groups = [];
  for (const b of data.buildings) {
    const key = b.grp || b.name;
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, label: b.grp || '', buildings: [] }; groups.push(g); }
    g.buildings.push(b);
  }

  const buildingRow = (b) => {
    const areas = areasFor(b.id).filter((a) => a.active);
    const tasks = areas.reduce((n, a) => n + a.tasks, 0);
    const search = [b.name, b.grp, ...areas.flatMap((a) => [a.name, ...(a.items ?? [])])]
      .join(' ').toLowerCase();
    return `<div class="list-item" data-search="${esc(search)}" style="${b.active ? '' : 'opacity:.5'}">
      <div class="spread wrap">
        <strong class="grow">${esc(b.name)}
          ${b.active ? '' : '<span class="pill idle">hidden</span>'}</strong>
        <button class="ghost" data-editb="${b.id}">Edit</button>
      </div>
      <div class="small muted" style="margin:4px 0 8px">
        ${areas.length} area${areas.length === 1 ? '' : 's'} · ${tasks} tasks</div>
      <div class="tabs" style="margin:0">
        ${areas.map((a) => `<button class="ghost" data-area="${a.id}">
          ${esc(a.name)} <span class="muted">${a.tasks}</span></button>`).join('')}
        <button class="ghost" data-addarea="${b.id}">+ Area</button>
      </div>
    </div>`;
  };

  app.innerHTML = `
    <div class="card">
      <div class="banner ${data.source === 'app' ? 'info' : 'warn'}">
        ${data.source === 'app'
          ? `<strong>Edited in the app.</strong> These checklists are now managed here, and
             <code>data/checklist.json</code> no longer overwrites them on deploy.`
          : `<strong>Managed by the checklist file.</strong> The first edit you make here
             takes over, and <code>data/checklist.json</code> stops being applied — so a
             later deploy can't quietly undo your work.`}
      </div>
    </div>

    <div class="card">
      <div class="pad" style="padding-bottom:0">
        <input id="search" placeholder="Search buildings, areas or items…" autocomplete="off">
      </div>
      <h2 style="border:none;padding-bottom:0">
        Buildings — ${data.buildings.filter((b) => b.active).length} active</h2>
      ${groups.map((g) => `
        ${g.label ? `<div class="grouphead">${esc(g.label)}</div>` : ''}
        ${g.buildings.map(buildingRow).join('')}
      `).join('')}
      <div class="pad"><button class="primary wide" id="addb">Add a building</button></div>
    </div>

    <div class="card danger">
      <h2>Restore from the checklist file</h2>
      <div class="pad">
        <p class="small muted" style="margin:0 0 10px">Throws away edits made here and
          rebuilds every checklist from <code>data/checklist.json</code>. Cleaning
          history is not affected.</p>
        <button class="wide danger" id="restore">Restore from file</button>
      </div>
    </div>`;

  app.querySelectorAll('[data-area]').forEach((b) => {
    b.onclick = () => { location.hash = `#/buildings/${b.dataset.area}`; };
  });
  app.querySelectorAll('[data-editb]').forEach((b) => {
    b.onclick = () => editBuilding(data.buildings.find((x) => x.id === Number(b.dataset.editb)));
  });
  app.querySelectorAll('[data-addarea]').forEach((b) => {
    b.onclick = () => editArea({ building_id: Number(b.dataset.addarea) });
  });
  $('#addb').onclick = () => editBuilding(null);

  $('#search').oninput = (ev) => {
    const q = ev.currentTarget.value.trim().toLowerCase();
    app.querySelectorAll('[data-search]').forEach((el) => {
      el.hidden = !(!q || el.dataset.search.includes(q));
    });
    // Hide any group heading whose buildings are now all filtered out. Stops
    // at the first element that isn't a building row - the last group's
    // heading sits right before the "Add a building" button, which must
    // never count as a visible row or that group's heading never hides.
    app.querySelectorAll('.grouphead').forEach((head) => {
      let sib = head.nextElementSibling;
      let anyVisible = false;
      while (sib && sib.matches('[data-search]')) {
        if (!sib.hidden) anyVisible = true;
        sib = sib.nextElementSibling;
      }
      head.hidden = !anyVisible;
    });
  };

  $('#restore').onclick = async () => {
    const typed = await askText({
      title: 'Restore from the checklist file?',
      body: 'Every building, area and item goes back to what <code>data/checklist.json</code> '
        + 'says. Anything you added here that is not in the file will be hidden. '
        + 'Cleaning records are kept.',
      label: 'Type "restore" to confirm',
      confirmText: 'Restore',
    });
    if (!typed) return;
    try {
      await api('/admin/checklist/restore', { method: 'POST', body: { confirm: typed } });
      toast('Restored from file');
      renderChecklistAdmin();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

function editBuilding(b) {
  const sheet = openSheet(`
    <div class="sheet-head"><strong>${b ? 'Edit building' : 'Add a building'}</strong></div>
    <div class="pad stack">
      <label class="field"><span>Name</span>
        <input id="bn" value="${esc(b?.name ?? '')}" placeholder="Bell Tent - St George 5"></label>
      <label class="field"><span>Group (optional)</span>
        <input id="bg" value="${esc(b?.grp ?? '')}" placeholder="Bell Tents"></label>
      ${b ? `<label class="check-row ${b.active ? 'on' : ''}" data-act>
          <input type="checkbox" ${b.active ? 'checked' : ''}>
          <span class="grow">Show on checklists and the schedule
            <span class="tiny muted" style="display:block">Turning this off hides it
              without touching its history.</span></span>
        </label>` : ''}
      <p class="err" id="err"></p>
      <button class="primary wide" id="save">${b ? 'Save' : 'Add building'}</button>
      <button class="wide" id="cancel">Cancel</button>
    </div>`);

  const act = sheet.querySelector('[data-act] input');
  if (act) act.onchange = () => act.closest('.check-row').classList.toggle('on', act.checked);
  sheet.querySelector('#cancel').onclick = closeSheet;
  sheet.querySelector('#save').onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await api('/admin/building', {
        method: 'POST',
        body: {
          id: b?.id,
          name: sheet.querySelector('#bn').value,
          group: sheet.querySelector('#bg').value,
          active: act ? act.checked : true,
        },
      });
      closeSheet();
      toast(b ? 'Building saved' : 'Building added');
      renderChecklistAdmin();
    } catch (e) {
      sheet.querySelector('#err').textContent = e.message;
      ev.currentTarget.disabled = false;
    }
  };
}

function editArea(a, onDone) {
  const sheet = openSheet(`
    <div class="sheet-head"><strong>${a?.id ? 'Edit area' : 'Add an area'}</strong></div>
    <div class="pad stack">
      <label class="field"><span>Area name</span>
        <input id="an" value="${esc(a?.name ?? '')}" placeholder="Bathrooms"></label>
      ${a?.id ? `<label class="check-row ${a.active ? 'on' : ''}" data-act>
          <input type="checkbox" ${a.active ? 'checked' : ''}>
          <span class="grow">Show on the checklist</span>
        </label>` : ''}
      <p class="err" id="err"></p>
      <button class="primary wide" id="save">${a?.id ? 'Save' : 'Add area'}</button>
      <button class="wide" id="cancel">Cancel</button>
    </div>`);

  const act = sheet.querySelector('[data-act] input');
  if (act) act.onchange = () => act.closest('.check-row').classList.toggle('on', act.checked);
  sheet.querySelector('#cancel').onclick = closeSheet;
  sheet.querySelector('#save').onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await api('/admin/area', {
        method: 'POST',
        body: {
          id: a?.id,
          buildingId: a?.building_id,
          name: sheet.querySelector('#an').value,
          active: act ? act.checked : true,
        },
      });
      closeSheet();
      toast('Saved');
      if (onDone) onDone(); else renderChecklistAdmin();
    } catch (e) {
      sheet.querySelector('#err').textContent = e.message;
      ev.currentTarget.disabled = false;
    }
  };
}

async function renderAreaEditor(areaId) {
  const data = await api(`/admin/area?id=${areaId}`);
  chrome({ title: data.area.name, back: true, section: 'buildings' });

  app.innerHTML = `
    <div class="card">
      <div class="pad spread wrap">
        <div>
          <strong>${esc(data.area.name)}</strong>
          <div class="small muted">${esc(data.area.building)}</div>
        </div>
        <button class="ghost" id="editarea">Rename or hide</button>
      </div>
    </div>

    <div class="card">
      <h2>Items — ${data.tasks.filter((t) => t.active).length} on the checklist</h2>
      ${data.tasks.map((t) => `<div class="list-item" style="${t.active ? '' : 'opacity:.5'}">
        <div class="spread wrap">
          <span class="grow">
            <strong>${esc(t.item)}</strong>
            ${t.active ? '' : '<span class="pill idle">hidden</span>'}
            <span class="small muted" style="display:block">${esc(t.description)}</span>
          </span>
          <button class="ghost" data-edit="${t.id}">Edit</button>
        </div>
      </div>`).join('') || '<div class="empty">No items yet.</div>'}
      <div class="pad"><button class="primary wide" id="addtask">Add an item</button></div>
    </div>

    <p class="tiny muted center">Hiding an item takes it off future checklists and keeps
      every record of it having been cleaned.</p>

    <div class="card danger">
      <h2>Delete this area</h2>
      <div class="pad">
        <p class="small muted" style="margin:0 0 10px">Removes <strong>${esc(data.area.name)}</strong>
          and every item in it completely — unlike hiding, this also deletes
          <strong>every record of it ever being cleaned</strong>. Only use this for an area
          that should never have existed. To take it off checklists but keep the history,
          use <strong>Rename or hide</strong> above instead.</p>
        <button class="wide danger" id="deletearea">Delete area permanently</button>
      </div>
    </div>`;

  $('#editarea').onclick = () => editArea(
    { ...data.area, building_id: data.area.building_id },
    () => renderAreaEditor(areaId),
  );
  $('#addtask').onclick = () => editTask({ area_id: areaId }, () => renderAreaEditor(areaId));
  app.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => editTask(
      data.tasks.find((t) => t.id === Number(b.dataset.edit)),
      () => renderAreaEditor(areaId),
    );
  });

  $('#deletearea').onclick = async () => {
    const typed = await askText({
      title: `Delete "${data.area.name}"?`,
      body: `This deletes the area, every item in it, and every day it was ever ticked.
             <strong>This cannot be undone.</strong>`,
      label: `Type the area name to confirm`,
      confirmText: 'Delete permanently',
      danger: true,
    });
    if (typed === null) return;
    try {
      await api('/admin/area/delete', { method: 'POST', body: { id: areaId, confirm: typed } });
      toast(`${data.area.name} deleted`);
      location.hash = '#/buildings';
    } catch (e) {
      toast(e.message, true);
    }
  };
}

function editTask(t, onDone) {
  const sheet = openSheet(`
    <div class="sheet-head"><strong>${t?.id ? 'Edit item' : 'Add an item'}</strong></div>
    <div class="pad stack">
      <label class="field"><span>Item</span>
        <input id="ti" value="${esc(t?.item ?? '')}" placeholder="Toilet"></label>
      <label class="field"><span>What to do</span>
        <input id="td" value="${esc(t?.description ?? '')}"
          placeholder="Clean including behind the cistern"></label>
      ${t?.id ? `<label class="check-row ${t.active ? 'on' : ''}" data-act>
          <input type="checkbox" ${t.active ? 'checked' : ''}>
          <span class="grow">Show on the checklist</span>
        </label>` : ''}
      <p class="err" id="err"></p>
      <button class="primary wide" id="save">${t?.id ? 'Save' : 'Add item'}</button>
      <button class="wide" id="cancel">Cancel</button>
    </div>`);

  const act = sheet.querySelector('[data-act] input');
  if (act) act.onchange = () => act.closest('.check-row').classList.toggle('on', act.checked);
  sheet.querySelector('#cancel').onclick = closeSheet;
  sheet.querySelector('#save').onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await api('/admin/task', {
        method: 'POST',
        body: {
          id: t?.id,
          areaId: t?.area_id,
          item: sheet.querySelector('#ti').value,
          description: sheet.querySelector('#td').value,
          active: act ? act.checked : true,
        },
      });
      closeSheet();
      toast('Saved');
      onDone();
    } catch (e) {
      sheet.querySelector('#err').textContent = e.message;
      ev.currentTarget.disabled = false;
    }
  };
}

/* ---------------------------------------------------------- view: admin */


async function renderAdmin() {
  const { users } = await api('/users');
  chrome({ title: 'People', section: 'admin' });

  app.innerHTML = `
    <div>
      <div class="card">
        <h2>Add someone</h2>
        <div class="pad stack narrow">
          <label class="field"><span>Name</span><input id="n"></label>
          <label class="field"><span>Role</span>
            <select id="r">
              <option value="cleaner">Cleaner — ticks checklists</option>
              <option value="office">Office — sees the overview, sets the schedule</option>
              <option value="admin">Admin — everything, including people</option>
            </select></label>
          <label class="field"><span>PIN (4-8 digits)</span>
            <input id="p" inputmode="numeric" pattern="\\d*"></label>
          <p class="err" id="err"></p>
          <button class="primary wide" id="add">Add person</button>
        </div>
      </div>

      <div class="card">
        <h2>Everyone — ${users.filter((u) => u.active).length} active</h2>
        <table class="grid">
          <tr><th>Name</th><th>Role</th><th></th></tr>
          ${users.map((u) => `<tr style="${u.active ? '' : 'opacity:.45'}"
              data-id="${u.id}" data-name="${esc(u.name)}" data-role="${esc(u.role)}"
              data-active="${u.active}">
            <td><span class="row" style="gap:9px">${avatar(u.name)}
              <span>${esc(u.name)}</span></span></td>
            <td class="muted">${esc(u.role)}${u.active ? '' : ' · disabled'}
              <span class="tiny" style="display:block">${daysSummary(u.availability)}</span></td>
            <td class="actions">
              <button class="ghost" data-days>Days</button>
              <button class="ghost" data-pin>New PIN</button>
              <button class="ghost" data-tog>${u.active ? 'Disable' : 'Enable'}</button>
              <button class="ghost danger" data-del
                ${u.id === state.user.id ? 'disabled title="You cannot delete yourself"' : ''}
                >Delete</button>
            </td></tr>`).join('')}
        </table>
        <p class="tiny muted pad" style="padding-top:0">
          PINs are stored hashed — they can be replaced, never read back.</p>
      </div>
    </div>

    <div class="card">
      <h2>Sign-in</h2>
      <label class="switch-row" style="cursor:pointer">
        <input type="checkbox" id="quick" ${state.config.quickSignin ? 'checked' : ''}
          style="width:20px;height:20px;min-height:20px;flex:none;accent-color:var(--accent)">
        <span class="grow">
          <strong style="display:block;font-size:14.5px">Test mode — tap a name to sign in</strong>
          <span class="small muted">Skips the PIN entirely. Handy while you set things up.
            <strong>Anyone with the link can sign in as anyone, including you.</strong>
            Turn it off before the cleaners start using it for real.</span>
        </span>
      </label>
    </div>

    <div class="card danger">
      <h2>Danger zone</h2>
      <div class="pad stack">
        <p class="small muted" style="margin:0">
          Clears every cleaning record, schedule, sign-off and maintenance report so you
          can start fresh after testing. Your buildings and checklists are
          <strong>not</strong> touched — those come from the checklist file. Tables are
          never deleted.</p>
        <label class="check-row" id="peoplerow">
          <input type="checkbox" id="wipepeople">
          <span class="grow">Also remove everyone except me
            <span class="tiny muted" style="display:block">You stay signed in as admin.</span></span>
        </label>
        <label class="field"><span>Type <code class="phrase">clear database</code> to confirm</span>
          <input id="confirm" placeholder="clear database" autocapitalize="none"
            autocomplete="off" spellcheck="false"></label>
        <p class="err" id="reseterr"></p>
        <button class="destroy wide" id="reset" disabled>Clear the database</button>
      </div>
    </div>`;

  $('#add').onclick = async () => {
    try {
      await api('/users', {
        method: 'POST',
        body: { name: $('#n').value, role: $('#r').value, pin: $('#p').value },
      });
      state.cleaners = null; // the assignment picker must pick up the new person
      toast('Person added');
      renderAdmin();
    } catch (e) {
      $('#err').textContent = e.message;
    }
  };

  $('#quick').onchange = async (ev) => {
    const on = ev.currentTarget.checked;
    try {
      const res = await api('/settings', { method: 'POST', body: { quickSignin: on } });
      state.config.quickSignin = res.quickSignin;
      state.configAt = Date.now();
      toast(on ? 'Test mode on — no PIN needed' : 'Test mode off — PIN required');
      renderAdmin();
    } catch (e) {
      ev.currentTarget.checked = !on;
      toast(e.message, true);
    }
  };

  // The button only wakes up once the phrase is typed exactly.
  const confirmBox = $('#confirm');
  const resetBtn = $('#reset');
  const phraseOk = () => confirmBox.value.trim().toLowerCase() === 'clear database';
  confirmBox.oninput = () => { resetBtn.disabled = !phraseOk(); };

  $('#wipepeople').onchange = (ev) => {
    ev.currentTarget.closest('.check-row').classList.toggle('on', ev.currentTarget.checked);
  };

  resetBtn.onclick = async () => {
    const alsoPeople = $('#wipepeople').checked;
    const go = await ask({
      title: 'Clear the database?',
      body: `This deletes every tick, sign-off, schedule and report${alsoPeople
        ? ', <strong>and removes everyone except you</strong>' : ''}.
        Your buildings and checklists are kept. <strong>This cannot be undone.</strong>`,
      confirmText: alsoPeople ? 'Clear everything' : 'Clear records',
      danger: true,
    });
    if (!go) return;

    resetBtn.disabled = true;
    try {
      const res = await api('/admin/reset', {
        method: 'POST',
        body: { confirm: confirmBox.value, includePeople: alsoPeople },
      });
      state.cleaners = null;
      toast(`Database cleared${res.removedPeople ? ` · ${res.removedPeople} people removed` : ''}`);
      location.hash = '#/';
    } catch (e) {
      $('#reseterr').textContent = e.message;
      resetBtn.disabled = !phraseOk();
    }
  };

  const rowOf = (btn) => btn.closest('tr').dataset;

  app.querySelectorAll('[data-days]').forEach((b) => {
    b.onclick = () => {
      const row = rowOf(b);
      const person = users.find((u) => u.id === Number(row.id));
      const sheet = openSheet(`
        <div class="sheet-head"><strong>${esc(person.name)}</strong></div>
        <div class="pad stack">
          <p class="dialog-body">Which days do they normally work? Used when building the
            roster — you can still assign them to any day.</p>
          <div class="check-list">${dayToggles(person.availability ?? Array(7).fill(null))}</div>
          <p class="err" id="err"></p>
          <button class="primary wide" id="save">Save</button>
          <button class="wide" id="cancel">Cancel</button>
        </div>`);
      wireDayToggles(sheet);
      sheet.querySelector('#cancel').onclick = closeSheet;
      sheet.querySelector('#save').onclick = async () => {
        try {
          await api('/availability', {
            method: 'POST',
            body: { userId: person.id, days: readDayToggles(sheet) },
          });
          closeSheet();
          state.cleaners = null;
          toast('Days saved');
          renderAdmin();
        } catch (e) {
          sheet.querySelector('#err').textContent = e.message;
        }
      };
    };
  });

  app.querySelectorAll('[data-pin]').forEach((b) => {
    b.onclick = async () => {
      const row = rowOf(b);
      const pin = await askText({
        title: 'Set a new PIN',
        body: `For <strong>${esc(row.name)}</strong>. They will need this to sign in.`,
        label: 'New PIN (4-8 digits)',
        confirmText: 'Set PIN',
        numeric: true,
      });
      if (!pin) return;
      try {
        await api('/users', {
          method: 'POST',
          body: {
            id: Number(row.id), name: row.name, role: row.role,
            active: Number(row.active), pin,
          },
        });
        toast('PIN updated');
      } catch (e) {
        toast(e.message, true);
      }
    };
  });

  app.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const row = rowOf(b);
      const go = await ask({
        title: `Delete ${row.name}?`,
        body: `They will be removed from the people list and taken off any
               buildings they are assigned to. <strong>What they have already
               cleaned stays in the records</strong> under their name.
               Disabling instead keeps the account and blocks sign-in.`,
        confirmText: 'Delete permanently',
        danger: true,
      });
      if (!go) return;
      try {
        await api('/users/delete', { method: 'POST', body: { id: Number(row.id) } });
        state.cleaners = null;
        toast(`${row.name} deleted`);
        renderAdmin();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });

  app.querySelectorAll('[data-tog]').forEach((b) => {
    b.onclick = async () => {
      const row = rowOf(b);
      try {
        await api('/users', {
          method: 'POST',
          body: {
            id: Number(row.id), name: row.name, role: row.role,
            active: row.active === '1' ? 0 : 1,
          },
        });
        state.cleaners = null;
        renderAdmin();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
}

/* --------------------------------------------------------------- router */

async function loadConfig() {
  // Refetched periodically so a tab left open overnight rolls onto the new day.
  if (state.config && Date.now() - state.configAt < 10 * 60_000) return;
  state.config = await api('/config');
  state.configAt = Date.now();
}

async function render() {
  stopPolling();
  closeSheet();

  try {
    await loadConfig();
  } catch (e) {
    app.innerHTML = `<div class="card pad"><p class="err">${esc(e.message)}</p></div>`;
    return;
  }

  if (!state.token || !state.user) return renderLogin();

  const [head, arg] = location.hash.replace(/^#\/?/, '').split('/');

  try {
    if (head === 'b' && arg) return await renderBuilding(Number(arg));
    if (head === 'schedule') return await renderSchedule();
    if (head === 'issues') return await renderIssues();
    if (head === 'history') return await renderHistory();
    if (head === 'admin') return await renderAdmin();
    if (head === 'buildings') return arg
      ? await renderAreaEditor(Number(arg))
      : await renderChecklistAdmin();
    return state.user.role === 'cleaner'
      ? await renderCleanerHome()
      : await renderOverview();
  } catch (e) {
    chrome({ title: 'Problem', back: true });
    app.innerHTML = `<div class="card pad"><p class="err">${esc(e.message)}</p></div>`;
  }
}

addEventListener('hashchange', render);
// Re-sync as soon as a cleaner takes the phone back out of their pocket.
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) render();
});
render();

/* ------------------------------------------------------------ install as app */

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  const btn = $('#installbtn');
  if (btn) btn.hidden = false;
});
addEventListener('appinstalled', () => {
  deferredInstall = null;
  $('#installhint')?.remove();
});

async function promptInstall() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
}
