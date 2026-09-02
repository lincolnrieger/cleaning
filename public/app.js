/* Woodhouse Cleaning Tracker - front end.
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
  weekFrom: null,  // first column of the schedule/roster/availability weeks
  poll: null,
  building: null,  // data for the checklist currently on screen
  editType: 'full', // which checklist the admin editor is showing
  collapsedGroups: new Set(), // building groups folded shut on Schedule/Checklists
  openSections: new Set(),    // secondary lists (e.g. "not scheduled") expanded open
  availFilter: { q: '', day: 'all', status: 'all', from: '', to: '' },
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
const DAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/* ------------------------------------------------------------ clean types */

/** The two checklists. Labels come from the API so they only exist in one place. */
const CLEAN_TYPES = () => state.config?.cleanTypes
  ?? [{ id: 'full', label: 'Full Clean' }, { id: 'check', label: 'Check' }];

const typeLabel = (id) => CLEAN_TYPES().find((t) => t.id === id)?.label ?? id;
const isCleanType = (id) => CLEAN_TYPES().some((t) => t.id === id);
const otherType = (id) => (id === 'full' ? 'check' : 'full');

/** One letter, for the schedule grid where a whole word won't fit. */
const typeTag = (id) => (id === 'check' ? 'C' : 'F');

/** There is one kind of report - something in a building needs fixing - so
    reporting is a description and a photo, with no category to choose first
    and no label to read afterwards. Older reports all read as this one. */
const REPORT_PLACEHOLDER = 'Broken cistern in the left cubicle…';

/** Monday = 0, to match DAY_NAMES and the stored availability array. */
const weekdayIndex = (day) => (asDate(day).getUTCDay() + 6) % 7;

/**
 * The API sends availability pre-parsed: 7 entries, each null (not working)
 * or { from, to }, where blank times mean "works, no particular hours".
 * Missing data reads as available rather than not - nobody should drop off
 * the roster because their record predates this.
 */
const availabilityOn = (person, day) => (Array.isArray(person.availability)
  ? person.availability[weekdayIndex(day)]
  : { from: '', to: '' });

const worksOn = (person, day) => Boolean(availabilityOn(person, day));

/** A day they would rather work. Softer than available: it never blocks. */
const prefersOn = (person, day) => Boolean(availabilityOn(person, day)?.preferred);

/**
 * "16h of 25h" when they've told us what they want in a week, "16h" when
 * they haven't. `over` is what turns the figure amber on the way past it.
 */
function hoursLabel(person) {
  const done = person.rosteredHours ?? 0;
  if (!person.idealHours) return done ? `${done}h` : '';
  return `${done}h of ${person.idealHours}h`;
}

const overHours = (person) =>
  Boolean(person.idealHours) && (person.rosteredHours ?? 0) > person.idealHours;

/** 08:00 -> 8am, 16:30 -> 4:30pm. Short enough for a roster cell. */
function shortTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')}${suffix}` : `${hour}${suffix}`;
}

const timeRange = (from, to) => (from && to ? `${shortTime(from)}–${shortTime(to)}` : '');

/** What one day of someone's availability reads as. */
function availabilityText(entry) {
  if (!entry) return 'Unavailable';
  return timeRange(entry.from, entry.to) || 'Available';
}

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

/**
 * Stable tone per person, out of five flat, low-chroma pairs.
 *
 * The point of colouring initials at all is telling two cleaners apart in a
 * dense grid at a glance. A hue per person did that and also turned every
 * screen into a rainbow; five muted tones do the same job and still read as
 * one set.
 */
const toneFor = (name) => {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return h % 5;
};

const avatar = (name, size = '') =>
  `<span class="avatar ${size}" data-tone="${toneFor(name)}" title="${esc(name)}"
     >${esc(initials(name))}</span>`;

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

/**
 * Thrown instead of a plain Error so callers can read the structured extras
 * the API sends with a 409 - which items still need a photo, which roster
 * conflicts were hit - rather than only the sentence.
 */
class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data ?? {};
  }
}

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
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
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
    const shot = img.closest('.shot');
    if (shot) shot.remove(); else img.remove();
  }
}

function signOut() {
  state.token = '';
  state.user = null;
  localStorage.removeItem('bc.token');
  localStorage.removeItem('bc.tokenAt');
  localStorage.removeItem('bc.user');
  location.hash = '';
  render();
}

/* --------------------------------------------------------------- chrome */

// One self-contained icon set (no font, no CDN), drawn on a 24px grid so the
// weights match at every size the app uses them. Replaces the emoji and the
// ▸ ▲ ✕ text glyphs, which rendered differently on every phone and read as
// decoration rather than controls.
const ICONS = {
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17"/>'
    + '<path d="M8 3v4M16 3v4"/>',
  clipboard: '<rect x="5.5" y="4.5" width="13" height="16" rx="2"/>'
    + '<path d="M9 4.5V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v.5"/><path d="M8.5 11h7M8.5 15h7"/>',
  phone: '<path d="M7.5 3.5h9a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M10.5 17.5h3"/>',
  list: '<path d="M9 6h10M9 12h10M9 18h10"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  people: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/>'
    + '<circle cx="17" cy="9" r="2.3"/><path d="M15.7 14.2c2.4.2 4.3 2 4.3 4.8"/>',

  // Points right when closed; CSS rotates it when aria-expanded flips, so no
  // code has to swap one arrow glyph for another.
  chevron: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  up: '<path d="M12 19V6"/><path d="m6 11.5 6-6 6 6"/>',
  down: '<path d="M12 5v13"/><path d="m6 12.5 6 6 6-6"/>',
  back: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  camera: '<path d="M4.5 8.5h3l1.5-2.5h6L16.5 8.5h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.2"/>',
  printer: '<path d="M7 9V4h10v5"/><rect x="3.5" y="9" width="17" height="7" rx="1.5"/><path d="M7 14h10v6H7z"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>',
  warning: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 4.5 4.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 5.5h-9a2 2 0 0 0-2 2v9"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5h5v2"/><path d="M6.5 7l1 12.5h9L17.5 7"/>',
  star: '<path d="m12 4.4 2.36 4.79 5.28.77-3.82 3.72.9 5.26L12 16.46l-4.72 2.48.9-5.26-3.82-3.72 5.28-.77z"/>',
};

/** An inline icon. `cls` takes `lg` for the 20px size. */
const svgIcon = (key, cls = '') =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[key]}</svg>`;

const icon = (key) => `<span class="navicon">${svgIcon(key)}</span>`;

// Building schedule, staff roster and availability are three views of the same
// week, so they share one nav entry and sit behind tabs. Six bottom-bar tabs
// is already the most a phone can carry legibly; eight would be unreadable.
const NAV = {
  cleaner: [
    ['', 'Today', 'home'],
    ['roster', 'Roster', 'calendar'],
    ['issues', 'Reports', 'clipboard'],
  ],
  office: [
    ['', 'Overview', 'home'],
    ['schedule', 'Planning', 'calendar'],
    ['issues', 'Reports', 'clipboard'],
  ],
  admin: [
    ['', 'Overview', 'home'],
    ['schedule', 'Planning', 'calendar'],
    ['issues', 'Reports', 'clipboard'],
    ['buildings', 'Checklists', 'list'],
    ['admin', 'People', 'people'],
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
    av.dataset.tone = toneFor(state.user.name);
  }

  // Impossible to forget that PIN-less sign-in is switched on.
  const testbar = $('#testbar');
  testbar.hidden = !state.config?.quickSignin;
  testbar.textContent = 'Test mode — anyone can sign in without a PIN. '
    + 'Turn this off under People before real use.';

  const items = state.user ? NAV[state.user.role] ?? [] : [];
  nav.hidden = !items.length;
  nav.innerHTML = items.map(([route, label, iconKey]) =>
    `<button data-route="${route}" aria-current="${route === section}">${icon(iconKey)}
      <span class="navlabel">${esc(label)}</span></button>`,
  ).join('');
  nav.querySelectorAll('[data-route]').forEach((b) => {
    b.onclick = () => { location.hash = `#/${b.dataset.route}`; };
  });

  // Hidden on detail screens (back === true) - a floating shortcut to report
  // something makes sense on a list/home screen, not on top of the report
  // form itself or a building's own checklist, which already has its own
  // report button in context.
  const fab = $('#quickfab');
  fab.hidden = !state.user || back;
  fab.onclick = openQuickReport;
}

/**
 * Which of the weekly screens the nav highlights. A cleaner's tab is the
 * staff roster - the building grid is the office's tool, and landing a
 * cleaner on it when they tapped "Roster" reads as the wrong screen.
 */
const planningSection = () => (state.user.role === 'cleaner' ? 'roster' : 'schedule');

/** The three weekly-planning screens, as one tab strip. */
function planningTabs(current) {
  const tabs = [['schedule', 'Buildings'], ['roster', 'Staff roster']];
  if (state.user.role !== 'cleaner') tabs.push(['availability', 'Availability']);
  return `<div class="tabs noprint">${tabs.map(([route, label]) =>
    `<button data-goto="${route}" aria-current="${route === current}">${esc(label)}</button>`,
  ).join('')}</div>`;
}

function wirePlanningTabs(root) {
  root.querySelectorAll('[data-goto]').forEach((b) => {
    b.onclick = () => { location.hash = `#/${b.dataset.goto}`; };
  });
}

$('#back').onclick = () => {
  // Going back is right for a detail page reached from a list; landing
  // straight on a deep link there is no history to go back to, so fall home.
  if (history.length > 1) history.back(); else location.hash = '#/';
};
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

/**
 * Guards against a slow screen painting over a newer one.
 *
 * Every view fetches before it draws, so on a weak signal a tap can start a
 * second screen while the first is still waiting. Without this the older
 * response wins whenever it happens to land last, and the app appears to jump
 * back to the page you just left. Each view claims a number on the way in and
 * checks it still holds the newest before writing any markup.
 */
let renderSeq = 0;
function screen(route = '') {
  const seq = ++renderSeq;
  // The route check covers the other direction: a background action - a copy,
  // a save - finishing after the user has already moved on, and redrawing the
  // screen they just left over the top of the one they asked for.
  return () => seq === renderSeq && (!route || location.hash.startsWith(route));
}

/* Day-picker strip, used by the office views. */
function dayNav(day) {
  const isToday = day === state.config.today;
  return `<div class="periodnav">
    <span class="pn-side pn-left">
      <button class="ghost" data-day="${esc(addDays(day, -1))}" aria-label="Previous day"
        >${svgIcon('back')}</button>
    </span>
    <span class="period-title">${esc(dayLabel(day))}
      <span class="period-sub num">${esc(auDate(day))}</span></span>
    <span class="pn-side pn-right">
      ${isToday ? '' : '<button class="ghost" data-day="today">Today</button>'}
      <button class="ghost" data-day="${esc(addDays(day, 1))}" aria-label="Next day"
        >${svgIcon('chevron')}</button>
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

/** Week-picker strip, shared by the schedule, roster and availability grids. */
function weekNav(from) {
  const thisWeek = startOfWeek(state.config.today);
  return `<div class="periodnav noprint">
    <span class="pn-side pn-left">
      <button class="ghost" data-week="${esc(addDays(from, -7))}" aria-label="Previous week"
        >${svgIcon('back')}</button>
    </span>
    <span class="period-title">
      ${esc(dayOfMonth(from))} – ${esc(dayOfMonth(addDays(from, 6)))}
      <span class="period-sub">${from === thisWeek ? 'This week'
        : `week commencing ${esc(auDate(from))}`}</span></span>
    <span class="pn-side pn-right">
      ${from === thisWeek ? ''
        : `<button class="ghost" data-week="${esc(thisWeek)}">This week</button>`}
      <button class="ghost" data-week="${esc(addDays(from, 7))}" aria-label="Next week"
        >${svgIcon('chevron')}</button>
    </span>
  </div>`;
}

function wireWeekNav(root, rerender) {
  root.querySelectorAll('[data-week]').forEach((b) => {
    b.onclick = () => { state.weekFrom = b.dataset.week; rerender(); };
  });
}

/** Monday of the week containing `day`. */
function startOfWeek(day) {
  const d = asDate(day);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(day, -dow);
}

const weekFrom = () => (state.weekFrom ||= startOfWeek(state.config.today));

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
            <span class="grow small">${checkbox}</span>
          </label>` : ''}
        <button class="${danger ? 'destroy' : 'primary'} wide" data-ok>${esc(confirmText)}</button>
        <button class="wide" data-cancel>${esc(cancelText)}</button>
      </div>`);

    const box = bg.querySelector('[data-extra] input');
    if (box) box.onchange = () => box.closest('.check-row').classList.toggle('on', box.checked);

    let settled = false;
    const observer = new MutationObserver(() => {
      if (!document.body.contains(bg)) done(false);
    });
    const done = (value) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      closeSheet();
      resolve(value);
    };

    bg.querySelector('[data-ok]').onclick = () => done(checkbox ? { checked: box.checked } : true);
    bg.querySelector('[data-cancel]').onclick = () => done(false);
    bg.onclick = (e) => { if (e.target === bg) done(false); };
    observer.observe(document.body, { childList: true });
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
    ${isIOS ? '' : '<button id="installbtn" hidden>Install</button>'}
    <button class="ghost" id="installclose" aria-label="Dismiss" title="Dismiss"
      >${svgIcon('close')}</button>
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
  $('#quickfab').hidden = true;
  $('#testbar').hidden = !state.config.quickSignin;
  $('#testbar').textContent = 'Test mode — tap any name to sign in, no PIN needed.';
  if (state.config.needsBootstrap) return renderBootstrap();
  return renderPeoplePicker();
}

/**
 * Half one of signing in: tap your name.
 *
 * Picking the person first is what lets the PIN be checked against them, so a
 * fumbled digit can never sign somebody in as a colleague and put the wrong
 * name on a morning's work. It also means the pad can greet them by name.
 */
async function renderPeoplePicker() {
  let people = [];
  try {
    people = (await api('/people')).people;
  } catch {
    return renderPinPad(); // no list to show; fall back to PIN alone
  }
  if (!people.length) return renderPinPad();

  // Whoever used this phone last goes first. On a personal phone that is the
  // owner, every time.
  const lastUid = Number(localStorage.getItem('bc.lastUid') || 0);
  people.sort((a, b) => (b.id === lastUid) - (a.id === lastUid));

  app.innerHTML = `<p class="loginmark">Woodhouse Cleaning</p>
  <div class="login card wide-login">
    <h2>Who are you?</h2>
    ${people.length > 10 ? `<div class="pad flush-bottom">
      <input id="findme" placeholder="Start typing your name…" autocomplete="off">
    </div>` : ''}
    <div class="pad people-grid">
      ${people.map((p) => `<button class="persontile" data-uid="${p.id}"
          data-pin="${p.pinLength || 0}" data-name="${esc(p.name)}"
          data-find="${esc(p.name.toLowerCase())}">
        ${avatar(p.name, 'lg')}
        <span class="ptname">${esc(firstName(p.name))}</span>
        ${p.name === firstName(p.name) ? '' : `<span class="ptfull">${esc(p.name)}</span>`}
      </button>`).join('')}
    </div>
    <p class="err center" id="err"></p>
  </div>
  ${installHintHTML()}`;

  const find = $('#findme');
  if (find) {
    find.oninput = () => {
      const q = find.value.trim().toLowerCase();
      app.querySelectorAll('[data-find]').forEach((b) => {
        b.hidden = Boolean(q) && !b.dataset.find.includes(q);
      });
    };
  }

  app.querySelectorAll('[data-uid]').forEach((b) => {
    b.onclick = async () => {
      const person = {
        id: Number(b.dataset.uid),
        name: b.dataset.name,
        pinLength: Number(b.dataset.pin),
      };
      // Test mode is the one case with nothing left to prove.
      if (state.config.quickSignin) {
        b.disabled = true;
        try {
          await signIn({ userId: person.id });
        } catch (e) {
          $('#err').textContent = e.message;
          b.disabled = false;
        }
        return;
      }
      renderPinPad(person);
    };
  });
  wireInstallHint();
}

async function signIn(body) {
  const { token, user } = await api('/login', { method: 'POST', body });
  state.token = token;
  state.user = user;
  localStorage.setItem('bc.token', token);
  localStorage.setItem('bc.tokenAt', String(Date.now()));
  localStorage.setItem('bc.user', JSON.stringify(user));
  localStorage.setItem('bc.lastUid', String(user.id));
  await render();
}

/**
 * Half two: the PIN, for the person just picked.
 *
 * Called with no `person` only when the list could not be fetched, where it
 * falls back to the older behaviour of the PIN alone identifying who you are.
 */
function renderPinPad(person = null) {
  // A known length means fixed slots and no button to reach for: the pad
  // submits on the last digit. People whose PIN predates that column show the
  // older growing dots and press Go.
  const slots = person?.pinLength >= 4 ? person.pinLength : 0;

  app.innerHTML = `<p class="loginmark">Woodhouse Cleaning</p>
  <div class="login card">
    ${person ? `<div class="pinhead">
      ${avatar(person.name, 'lg')}
      <span class="grow">
        <strong>${esc(person.name)}</strong>
        <span class="small muted">Enter your PIN</span>
      </span>
    </div>` : ''}
    <div class="pad stack center">
      ${person ? '' : '<p class="muted">Enter your PIN</p>'}
      <div class="pinslots" id="dots" data-slots="${slots}"></div>
      <p class="err" id="err"></p>
      <div class="pinpad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join('')}
        <span class="padgap"></span>
        <button data-k="0">0</button>
        <button class="ghost" data-k="del" aria-label="Delete"
          >${svgIcon('back', 'lg')}</button>
        ${slots ? '' : `<button class="primary wide" data-k="go">Sign in</button>`}
      </div>
      ${person
        ? '<button class="wide" id="notme">Not you? Pick another name</button>'
        : state.config.quickSignin
          ? '<button class="wide" id="uselist">Pick from the list instead</button>'
          : ''}
    </div>
  </div>
  ${person ? '' : installHintHTML()}`;

  $('#uselist')?.addEventListener('click', renderPeoplePicker);
  $('#notme')?.addEventListener('click', renderPeoplePicker);
  if (!person) wireInstallHint();

  let pin = '';
  const dots = $('#dots');
  const err = $('#err');
  const draw = () => {
    dots.innerHTML = slots
      ? Array.from({ length: slots }, (_, i) =>
        `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('')
      : '•'.repeat(pin.length);
  };
  draw();

  async function submit() {
    if (pin.length < 4) return;
    err.textContent = '';
    dots.classList.add('working');
    try {
      await signIn(person ? { userId: person.id, pin } : { pin });
    } catch (e) {
      pin = '';
      dots.classList.remove('working');
      draw();
      err.textContent = e.message;
    }
  }

  const type = (k) => {
    if (k === 'del') pin = pin.slice(0, -1);
    else if (k === 'go') return submit();
    else if (pin.length < 8) pin += k;
    draw();
    // The last slot filled is the whole intent - nobody needs to confirm it.
    if (slots && pin.length === slots) submit();
  };

  app.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => type(b.dataset.k); });

  addEventListener('keydown', function onKey(e) {
    if (!document.body.contains(dots)) return removeEventListener('keydown', onKey);
    if (/^\d$/.test(e.key)) type(e.key);
    else if (e.key === 'Backspace') type('del');
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
  const live = screen();
  const day = viewDay();
  const { buildings } = await api(`/overview?day=${day}`);
  if (!live()) return;
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
  const stale = rest.filter((b) => staleDays(b, day) >= 7);
  const fullCount = runSheet.filter((b) => b.cleanType === 'full').length;
  const signedPct = runSheet.length ? Math.round((totals.signed / runSheet.length) * 100) : 0;
  const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;

  app.innerHTML = `
    <div class="card"><div class="pad tight">${dayNav(day)}</div></div>

    <div class="card">
      <div class="pad">
        <p class="headline">${runSheet.length
          ? `<b class="num">${totals.signed} of ${runSheet.length}</b>
             ${plural(runSheet.length, 'building')} signed off`
          : '<b>Nothing scheduled</b>'}</p>
        ${runSheet.length ? `<div class="meter lg ${signedPct === 100 ? 'full' : ''}">
          <i style="width:${signedPct}%"></i></div>` : ''}
      </div>
      ${runSheet.length ? `<div class="stats">
        <div class="stat ${outstanding ? 'is-warn' : 'is-done'}">
          <b class="num">${outstanding}</b><span>still to clean</span></div>
        <div class="stat"><b class="num">${pct}%</b><span>of tasks ticked</span></div>
        <div class="stat ${totals.issues ? 'is-warn' : ''}">
          <b class="num">${totals.issues}</b><span>open ${plural(totals.issues, 'issue')}</span></div>
      </div>` : ''}
      ${runSheet.length ? `<div class="pad tight small muted center">
        ${totals.done} of ${totals.total} tasks —
        ${fullCount} full ${plural(fullCount, 'clean')},
        ${runSheet.length - fullCount} ${plural(runSheet.length - fullCount, 'check')}
      </div>` : totals.issues ? `<div class="pad tight small muted center">
        ${totals.issues} open ${plural(totals.issues, 'issue')}
      </div>` : ''}
    </div>

    <div class="card">
      <h2><span class="grow">Run sheet</span>
        <span class="num">${runSheet.length ? `${outstanding} of ${runSheet.length} left`
          : 'nothing scheduled'}</span></h2>
      ${runSheet.length
        ? runSheet.map(overviewTile).join('')
        : `<div class="empty"><b>Nothing scheduled</b>
           Open Planning to plan the week.</div>`}
    </div>

    ${rest.length ? `<div class="card">
      ${sectionToggle('overview-rest',
        dayLabel(day).toLowerCase() === 'today' ? 'Not scheduled today' : 'Not scheduled this day',
        rest.length)}
      ${state.openSections.has('overview-rest')
        ? `<div class="crow-list">${rest.map(compactRow).join('')}</div>` : ''}
    </div>` : ''}

    ${stale.length ? `<div class="card"><div class="pad tight small muted">
      Not cleaned in a week or more:
      <strong>${stale.map((b) => esc(b.name)).join(', ')}</strong>.
    </div></div>` : ''}

    <button class="wide ghost" id="csv">${svgIcon('download')} Download this day as CSV</button>`;

  $('#csv').onclick = () => download(`/report?from=${day}&to=${day}`, `cleaning-${auDate(day)}.csv`);

  wireTiles();
  wireDayNav(app, renderOverview);
  wireSectionToggles(app, renderOverview);
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

/** The badge that says which of the two checklists a job is. */
const typePill = (id, extra = '') =>
  `<span class="pill type-${esc(id)}">${esc(typeLabel(id))}${extra}</span>`;

function overviewTile(b) {
  const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
  const status = b.completed_at
    ? `<span class="pill done">Signed off<span class="hide-narrow"> ${
      esc(time(b.completed_at))}</span></span>`
    : b.done
      ? '<span class="pill open">In progress</span>'
      : b.scheduled
        ? '<span class="pill late">Not started</span>'
        : '<span class="pill idle">Not started</span>';

  // A building can be checked in the morning and fully cleaned later; name the
  // other sign-off rather than letting it vanish behind whichever is scheduled.
  const alsoDone = b.signedOff.filter((s) => s.cleanType !== b.cleanType);

  const meta = [
    b.crew.length ? `worked by ${b.crew.map((c) => esc(firstName(c))).join(', ')}` : null,
    b.last_at ? `last ${esc(time(b.last_at))}` : null,
    b.open_issues ? `${b.open_issues} open issue${b.open_issues > 1 ? 's' : ''}` : null,
    alsoDone.length
      ? alsoDone.map((s) => `${esc(typeLabel(s.cleanType))} done ${esc(time(s.at))}`).join(', ')
      : null,
    b.grp && b.grp !== b.name ? esc(b.grp) : null,
    b.completed_at ? null : esc(sinceLabel(b.lastCleaned, state.config.today)),
    b.note ? esc(b.note) : null,
  ].filter(Boolean).join(' · ');

  // Only the green 'done' edge earns its place - the status pill already
  // carries 'outstanding', and every run-sheet row is outstanding by definition.
  const edge = b.completed_at ? ' finished' : '';

  return `<button class="tile${edge}"
      ${canDrillIn() ? `data-b="${b.id}" data-type="${esc(b.cleanType)}"` : 'disabled'}>
    <span class="tile-main">
      <span class="tile-title">
        ${b.scheduled ? `<span class="prio num">${b.priority}</span>` : ''}
        <span class="name">${esc(b.name)}</span>
      </span>
      <span class="tile-meta">${typePill(b.cleanType)}
        <span class="grow">${meta}</span></span>
    </span>
    <span class="tile-end">${status}
      <span class="tile-count num">${b.done}/${b.total}<span class="hide-narrow"> tasks</span></span></span>
    ${canDrillIn() ? svgIcon('chevron', 'lg tile-chev') : ''}
    ${b.done ? `<span class="meter ${pct === 100 ? 'full' : ''}">
      <i style="width:${pct}%"></i></span>` : ''}
  </button>`;
}

/**
 * A single line per building for the "not scheduled" list, which routinely
 * runs to 15-20 rows in a full park. Progress and priority don't apply to a
 * building nobody's touching today, so this drops both and shows only what's
 * actually worth a glance: name, staleness, and whether it has an open issue.
 */
function compactRow(b) {
  return `<button class="crow" ${canDrillIn() ? `data-b="${b.id}"` : 'disabled'}>
    <span class="crow-top">
      <span class="crow-name">${esc(b.name)}</span>
      ${b.open_issues ? `<span class="crow-dot" title="${b.open_issues} open issue${
        b.open_issues > 1 ? 's' : ''}"></span>` : ''}
    </span>
    <span class="crow-sub">${esc(sinceLabel(b.lastCleaned, state.config.today))}${
      b.done ? ` · <span class="num">${b.done}/${b.total}</span> done` : ''}</span>
  </button>`;
}

/** True when this user is allowed to open an individual building's checklist. */
const canDrillIn = () => state.user.role !== 'office' || !state.config.rollupOnly;

function wireTiles() {
  app.querySelectorAll('[data-b]').forEach((el) => {
    el.onclick = () => {
      const id = Number(el.dataset.b);
      // Scheduled work goes straight to the checklist the office asked for.
      // Anything else asks which of the two, because guessing is exactly how
      // somebody ends up doing a full clean when a check was wanted.
      if (el.dataset.type) location.hash = `#/b/${id}/${el.dataset.type}`;
      else openTypeChooser(id, el.querySelector('.crow-name, .name')?.textContent ?? 'this building');
    };
  });
  app.querySelectorAll('[data-go]').forEach((el) => {
    el.onclick = () => { location.hash = el.dataset.go; };
  });
}

/** Two big buttons: which clean is this? */
function openTypeChooser(buildingId, name) {
  const sheet = openSheet(`
    <div class="sheet-head"><strong>${esc(name)}</strong></div>
    <div class="pad stack">
      <p class="dialog-body">Which clean are you doing?</p>
      ${CLEAN_TYPES().map((t) => `<button class="bigchoice" data-pick="${esc(t.id)}">
        <strong>${esc(t.label)}</strong>
        <span class="small muted">${t.id === 'full'
          ? 'The full checklist for this building'
          : 'The shorter walk-through checklist'}</span>
      </button>`).join('')}
      <button class="wide" id="cancel">Cancel</button>
    </div>`);

  sheet.querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = () => {
      closeSheet();
      location.hash = `#/b/${buildingId}/${b.dataset.pick}`;
    };
  });
  sheet.querySelector('#cancel').onclick = closeSheet;
}

/* -------------------------------------------------- building group folding */

/**
 * Groups buildings by their `grp` field (or their own name when ungrouped),
 * preserving the order groups first appear. Used to fold buildings like
 * "Bell Tents" or "Chalets" under one shared, collapsible heading.
 */
function groupBuildings(buildings) {
  const groups = [];
  for (const b of buildings) {
    const key = b.grp || b.name;
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, label: b.grp || '', buildings: [] }; groups.push(g); }
    g.buildings.push(b);
  }
  return groups;
}

/**
 * Wires a group-heading element as a fold/unfold toggle: flips its entry in
 * `state.collapsedGroups`, updates the chevron and aria-expanded, then hands
 * control to `onToggle` to actually show or hide that group's rows - the
 * two callers (a table and a plain list) do that differently.
 */
function wireGroupToggle(el, key, onToggle) {
  const toggle = () => {
    const collapsed = state.collapsedGroups.has(key);
    if (collapsed) state.collapsedGroups.delete(key); else state.collapsedGroups.add(key);
    const nowCollapsed = !collapsed;
    // The chevron is one SVG that CSS rotates off aria-expanded, so there is
    // no second source of truth to keep in step.
    el.setAttribute('aria-expanded', String(!nowCollapsed));
    onToggle(nowCollapsed);
  };
  el.onclick = toggle;
  el.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  };
}

/**
 * A card section that starts collapsed - for a secondary list (buildings not
 * scheduled, buildings not assigned to you) that would otherwise dominate
 * the screen with mostly-irrelevant rows. Unlike wireGroupToggle's fold
 * (which defaults open), this defaults shut: `key` only appears in
 * `state.openSections` once someone's actually asked to see it.
 */
function sectionToggle(key, label, count) {
  const open = state.openSections.has(key);
  return `<button class="card-toggle" data-opensec="${esc(key)}" aria-expanded="${open}">
    ${svgIcon('chevron', 'chev')}
    <span class="grow">${esc(label)}</span>
    <span class="muted small num">${count}</span>
  </button>`;
}

function wireSectionToggles(root, rerender) {
  root.querySelectorAll('[data-opensec]').forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.opensec;
      if (state.openSections.has(key)) state.openSections.delete(key);
      else state.openSections.add(key);
      rerender();
    };
  });
}

/* ------------------------------------------------------ view: cleaner home */

async function renderCleanerHome() {
  const live = screen();
  const today = state.config.today;
  const [{ buildings }, roster] = await Promise.all([
    api(`/overview?day=${today}`),
    // null, not an empty roster: a failed request must not be mistaken for
    // "you aren't on today", which is a thing the screen now says out loud.
    api(`/roster?from=${today}&days=1`).catch(() => null),
  ]);
  if (!live()) return;
  // "Today, Tue 12 Aug" is a fact they can act on; a greeting is not.
  chrome({ title: 'Today', section: '' });

  // The plan says what needs cleaning, not who does it, so today's list is
  // the same for everyone: what is on, in priority order.
  const todays = buildings.filter((b) => b.scheduled);
  const rest = buildings.filter((b) => !b.scheduled);

  const doneCount = todays.filter((b) => b.completed_at).length;
  const myShifts = roster ? (roster.shifts ?? []).filter((s) => s.user_id === state.user.id) : null;

  const left = todays.length - doneCount;
  const pct = todays.length ? Math.round((doneCount / todays.length) * 100) : 0;
  const phones = [
    ['Office', state.config.officePhone],
    ['Maintenance', state.config.maintenancePhone],
  ].filter(([, n]) => n);

  app.innerHTML = `
    <div class="card">
      <div class="pad">
        <p class="daystamp"><strong>${esc(dayLabel(today))}</strong>
          <span class="num">${esc(auDate(today))}</span></p>
        <p class="headline">${todays.length
          ? `<b class="num">${left}</b> ${left === 1 ? 'building' : 'buildings'} left to clean`
          : '<b>Nothing scheduled</b>'}</p>
        ${todays.length ? `<div class="meter lg ${pct === 100 ? 'full' : ''}">
          <i style="width:${pct}%"></i></div>
          <p class="tiny muted gap-top-sm">${doneCount} of ${todays.length} done today</p>` : ''}
      </div>
      ${myShifts?.length ? `<div class="banner info">
        <strong>You're on ${myShifts.map((s) =>
          esc(timeRange(s.start_time, s.end_time))).join(' and ')}</strong>
        ${myShifts.some((s) => s.note)
          ? `<div class="tiny">${
            myShifts.filter((s) => s.note).map((s) => esc(s.note)).join(' · ')}</div>` : ''}
      </div>` : myShifts ? `<div class="banner warn">
        <strong>You're not on today</strong>
        <div class="tiny">Nothing is rostered to you. Check the roster if that
          looks wrong.</div>
      </div>` : ''}
    </div>

    ${todays.length ? `<div class="card">
      <h2><span class="grow">To clean today</span>
        <span class="num">${left} left</span></h2>
      ${todays.map((b) => jobTile(b)).join('')}
    </div>` : `<div class="card"><div class="empty">
      <b>Nothing scheduled today</b>
      Pick any building below and start whenever you like.
    </div></div>`}

    ${rest.length ? `<div class="card">
      ${sectionToggle('home-rest', 'Other buildings', rest.length)}
      ${state.openSections.has('home-rest')
        ? `<div class="crow-list">${rest.map(compactRow).join('')}</div>` : ''}
    </div>` : ''}

    ${phones.length ? `<div class="card">
      <h2>Need a hand?</h2>
      <div class="pad callrow">
        ${phones.map(([label, n]) => `<a class="btn wide" href="tel:${esc(n.replace(/\s/g, ''))}"
          >${svgIcon('phone')} ${esc(label)} <span class="num muted">${esc(n)}</span></a>`).join('')}
      </div>
    </div>` : ''}`;

  wireTiles();
  wireSectionToggles(app, renderCleanerHome);
  poll(renderCleanerHome, 60000);
}

function jobTile(b) {
  const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
  const status = b.completed_at
    ? `<span class="pill done">Done ${esc(time(b.completed_at))}</span>`
    : b.done ? '<span class="pill open">In progress</span>'
             : '<span class="pill idle">Not started</span>';

  // Who is already on it, so two people don't start the same building.
  const who = b.crew.length
    ? `${b.completed_at ? 'by' : 'started by'} ${
      b.crew.map((c) => esc(firstName(c))).join(', ')}`
    : '';

  return `<button class="tile${b.completed_at ? ' finished' : ''}"
      data-b="${b.id}" data-type="${esc(b.cleanType)}">
    <span class="tile-main">
      <span class="tile-title">
        ${b.scheduled ? `<span class="prio num">${b.priority}</span>` : ''}
        <span class="name">${esc(b.name)}</span>
      </span>
      <span class="tile-meta">${typePill(b.cleanType)}
        <span class="grow">${who}${
          b.note ? `${who ? ' · ' : ''}${esc(b.note)}` : ''}</span></span>
    </span>
    <span class="tile-end">${status}
      <span class="tile-count num">${b.done}/${b.total}<span class="hide-narrow"> tasks</span></span></span>
    ${svgIcon('chevron', 'lg tile-chev')}
    ${b.done ? `<span class="meter ${pct === 100 ? 'full' : ''}">
      <i style="width:${pct}%"></i></span>` : ''}
  </button>`;
}

/* --------------------------------------------------- view: schedule grid */

async function renderSchedule() {
  const live = screen('#/schedule');
  const from = weekFrom();
  const data = await api(`/schedule?from=${from}&days=7`);
  if (!live()) return;
  chrome({
    title: state.user.role === 'cleaner' ? 'This week' : 'Planning',
    section: planningSection(), wide: true,
  });
  const canEdit = data.canEdit;

  const isWeekend = (d) => [0, 6].includes(asDate(d).getUTCDay());

  const cell = (b, day) => {
    const c = data.cells[`${b.id}:${day}`] ?? {};
    const scheduled = c.priority != null;
    const type = c.cleanType ?? c.completedType ?? 'full';
    const size = b.sizes?.[type] ?? 0;
    const pct = size && c.done ? Math.round((c.done / size) * 100) : 0;
    const classes = [
      'cell',
      scheduled ? 'on' : '',
      scheduled ? `t-${type}` : '',
      c.completedAt ? 'complete' : '',
    ].filter(Boolean).join(' ');

    let inner;
    if (scheduled || c.done || c.completedAt) {
      inner = `<div class="cell-top">
          ${scheduled ? `<span class="prio">${c.priority}</span>` : ''}
          ${scheduled ? `<span class="typetag t-${type}"
            title="${esc(typeLabel(type))}">${typeTag(type)}</span>` : ''}
          ${c.completedAt ? `<span class="tickmark">${svgIcon('check')}</span>` : ''}
        </div>
        ${scheduled
          ? `<span class="printonly celltype">${esc(typeLabel(type))}</span>` : ''}
        ${c.note ? `<div class="names">${esc(c.note)}</div>` : ''}
        ${c.done ? `<div class="mini ${pct === 100 ? 'full' : ''}"><i style="width:${pct}%"></i></div>` : ''}`;
    } else {
      inner = canEdit ? '<span class="plus">+</span>' : '';
    }

    const tdCls = [day === data.today ? 'today-col' : '', isWeekend(day) ? 'weekend' : '']
      .filter(Boolean).join(' ');
    return `<td class="${tdCls}">
      <button class="${classes}" data-cell="${b.id}|${day}"
        title="${esc(b.name)} — ${esc(dayLabel(day))}${scheduled ? ` — ${esc(typeLabel(type))}` : ''}"
        ${canEdit ? '' : 'disabled'}>${inner}</button></td>`;
  };

  app.innerHTML = `
    ${planningTabs('schedule')}
    <div class="card noprint"><div class="pad">${weekNav(from)}</div></div>

    <div class="card" id="printarea">
      <h1 class="printonly print-title">Cleaning Plan - Week Commencing ${esc(auDate(from))}</h1>
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
            ${groupBuildings(data.buildings).map((g) => {
              const folded = g.label && state.collapsedGroups.has(g.key);
              const head = g.label ? `<tr class="grouphead-row">
                <th colspan="${1 + data.days.length}">
                  <div class="grouphead" data-grouptoggle="${esc(g.key)}"
                    role="button" tabindex="0" aria-expanded="${!folded}">
                    ${svgIcon('chevron', 'chev')}
                    <span class="grow">${esc(g.label)}</span>
                    <span class="num">${g.buildings.length}</span>
                  </div>
                </th></tr>` : '';
              return head + g.buildings.map((b) => {
                const weekCount = data.days
                  .filter((d) => data.cells[`${b.id}:${d}`]?.priority != null).length;
                return `<tr data-group="${esc(g.key)}" ${folded ? 'hidden' : ''}>
                  <th class="rowhead">${esc(b.name)}
                    <small>${weekCount ? `${weekCount} this week` : 'not scheduled'}</small></th>
                  ${data.days.map((d) => cell(b, d)).join('')}
                </tr>`;
              }).join('');
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="legend">
        <span><i class="sw t-full"></i>Full Clean</span>
        <span><i class="sw t-check"></i>Check</span>
        <span><i class="sw done"></i>Signed off</span>
      </div>
      <p class="printonly print-foot">
        The number is the order it gets done in · a tick means signed off</p>
    </div>

    <div class="row wrap noprint">
      <button id="print">${svgIcon('printer')} Print / save as PDF</button>
    </div>

    <p class="tiny muted center noprint">
      ${canEdit
        ? 'Tap any square to put that building on the plan, pick Full Clean or Check, and set the order it gets done in.'
        : 'This is the plan. The office sets it — tap a building on your home screen to start cleaning.'}
    </p>`;

  wirePlanningTabs(app);
  wireWeekNav(app, renderSchedule);
  $('#print').onclick = () => window.print();

  app.querySelectorAll('[data-grouptoggle]').forEach((head) => {
    const key = head.dataset.grouptoggle;
    wireGroupToggle(head, key, (collapsed) => {
      app.querySelectorAll(`tr[data-group]`).forEach((row) => {
        if (row.dataset.group === key) row.hidden = collapsed;
      });
    });
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

function openScheduleEditor(data, buildingId, day) {
  const building = data.buildings.find((b) => b.id === buildingId);
  const cell = data.cells[`${buildingId}:${day}`] ?? {};
  const scheduled = cell.priority != null;
  let cleanType = cell.cleanType ?? 'full';

  const sheet = openSheet(`
    <div class="sheet-head">
      <div>
        <strong>${esc(building.name)}</strong>
        <div class="small muted">${esc(dayLabel(day))} · ${esc(dayOfMonth(day))}</div>
      </div>
      ${scheduled ? '<span class="pill open">Scheduled</span>' : ''}
    </div>
    <div class="pad stack">
      <div class="field"><span>Which clean?</span>
        <div class="seg" id="typeSeg">
          ${CLEAN_TYPES().map((t) => `<button type="button" class="seg-btn"
            data-type="${esc(t.id)}" aria-pressed="${t.id === cleanType}">${esc(t.label)}
            <span class="tiny muted">${
              building.sizes?.[t.id] ?? 0} items</span></button>`).join('')}
        </div></div>

      <label class="field"><span>Order of priority — 1 gets done first</span>
        <input id="prio" type="number" min="1" max="99" inputmode="numeric"
          value="${scheduled ? cell.priority : nextPriority(data, day)}"></label>

      <label class="field"><span>Note for this job (optional)</span>
        <input id="note" maxlength="200" value="${esc(cell.note ?? '')}"
          placeholder="Group arriving 2pm — finish by 1pm"></label>

      <p class="err" id="err"></p>
      <button class="primary wide" id="save">${scheduled ? 'Save changes' : 'Add to schedule'}</button>
      ${scheduled ? '<button class="wide danger" id="clear">Remove from schedule</button>' : ''}
      <button class="wide" id="cancel">Cancel</button>
    </div>`);

  sheet.querySelectorAll('[data-type]').forEach((b) => {
    b.onclick = () => {
      cleanType = b.dataset.type;
      sheet.querySelectorAll('[data-type]').forEach((x) =>
        x.setAttribute('aria-pressed', String(x === b)));
    };
  });

  sheet.querySelector('#cancel').onclick = closeSheet;

  sheet.querySelector('#save').onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await api('/schedule', {
        method: 'POST',
        body: {
          buildingId, day, cleanType,
          priority: Number(sheet.querySelector('#prio').value) || 1,
          note: sheet.querySelector('#note').value,
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
        ? `Also wipe that day's ticks, photos and sign-off
           <span class="tiny muted">Only for the
             ${esc(typeLabel(cell.cleanType ?? 'full'))} checklist. Goes back to 0 done.</span>`
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

async function renderBuilding(id, wantType) {
  const live = screen('#/b/');
  const day = state.user.role === 'cleaner' ? state.config.today : viewDay();

  let data;
  try {
    const q = isCleanType(wantType) ? `&type=${wantType}` : '';
    data = await api(`/building?id=${id}&day=${day}${q}`);
  } catch (e) {
    if (!live()) return;
    chrome({ title: 'Not available', back: true });
    app.innerHTML = `<div class="card pad"><p class="err">${esc(e.message)}</p></div>`;
    return;
  }
  if (!live()) return;

  state.building = data;
  chrome({ title: data.building.name, back: true });
  const locked = data.readOnly;
  const type = data.cleanType;
  // Warn when the office planned the other one - the single most expensive
  // mistake this app can let somebody make is cleaning the wrong list.
  const mismatch = data.scheduledType && data.scheduledType !== type;

  app.innerHTML = `
    <div class="card">
      <div class="pad">
        ${state.user.role !== 'cleaner' ? `${dayNav(day)}<div class="gap-top"></div>` : ''}
        <div class="seg" id="typeSeg">
          ${CLEAN_TYPES().map((t) => `<button type="button" class="seg-btn"
            data-type="${esc(t.id)}" aria-pressed="${t.id === type}">${esc(t.label)}
            <span class="tiny num">${data.sizes[t.id]} items</span>
          </button>`).join('')}
        </div>
      </div>
      ${mismatch ? `<div class="banner warn">
        <strong>The office scheduled a ${esc(typeLabel(data.scheduledType))} here.</strong>
        You're on the ${esc(typeLabel(type))} checklist.
      </div>` : ''}
      ${data.scheduleNote ? `<div class="banner info">
        <strong>From the office:</strong> ${esc(data.scheduleNote)}</div>` : ''}
      <p class="pad tight small" id="signoff" hidden></p>
    </div>

    <!-- Follows you down the list, so "how far am I" never needs a scroll up. -->
    <div class="progresshead">
      <div class="progresshead-inner">
        <span class="count num grow" id="count"></span>
        <span class="small muted nowrap">${esc(dayLabel(day))}</span>
      </div>
      <div class="meter" id="meter"><i></i></div>
    </div>

    <div class="card" id="items">
      ${data.items.length
        ? data.items.map((t) => taskRow(t, locked)).join('')
        : `<div class="empty"><b>Nothing on this checklist</b>
           The office can add areas under Checklists.</div>`}
    </div>
    ${data.items.length ? `<p class="tiny muted center">
      Tick each area as you finish it — what it covers is listed under it.</p>` : ''}

    <div class="card" id="issues" hidden><h2>Open issues here</h2><div id="issuelist"></div></div>

    ${locked ? '<p class="note center">Read-only — only cleaners can tick items.</p>' : `
      <!-- The action that ends the job stays in reach instead of sitting
           below sixty items. -->
      <div class="actionbar">
        <button class="primary" id="complete"></button>
        <button id="report" title="Report something that needs fixing"
          >${svgIcon('warning')} Report</button>
      </div>`}`;

  paintBuilding(data, locked);
  wireTaskPhotos(id, day, locked);

  app.querySelectorAll('#typeSeg [data-type]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.type === type) return;
      location.hash = `#/b/${id}/${b.dataset.type}`;
    };
  });

  if (state.user.role !== 'cleaner') wireDayNav(app, () => renderBuilding(id, type));

  if (!locked) {
    app.querySelectorAll('.task').forEach((el) => {
      el.onclick = () => toggleTask(el, id, day);
    });
    $('#report').onclick = () => renderReport(data);
    $('#complete').onclick = () => completeBuilding(id, day, type, data, locked);
  }

  // Frequent enough that two cleaners in the same room see each other's ticks.
  poll(() => refreshBuilding(id, day, type, locked), 20000);
}

async function completeBuilding(id, day, type, data, locked) {
  const { done, total } = counts(state.building);
  const undo = Boolean(state.building.completed);
  const left = total - done;

  const go = await ask({
    title: undo
      ? `Reopen this ${typeLabel(type).toLowerCase()}?`
      : `Finished the ${typeLabel(type).toLowerCase()} at ${data.building.name}?`,
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

  const send = (override) => api('/building/complete', {
    method: 'POST', body: { buildingId: id, day, undo, cleanType: type, override },
  });

  try {
    let res;
    try {
      res = await send(false);
    } catch (e) {
      // The server refuses when an item the admin marked "photo required" has
      // no photo. A dead phone camera shouldn't strand a finished building, so
      // this can be overridden - but never silently, and the override is
      // written into the activity log.
      if (e.status !== 409 || !e.data.missingPhotos) throw e;
      const missing = e.data.missingPhotos;
      const anyway = await ask({
        title: 'Some photos are missing',
        body: `These items need a photo before this counts as finished:
          <br><strong>${missing.slice(0, 6).map((m) => esc(m.item)).join('<br>')}</strong>
          ${missing.length > 6 ? `<br>…and ${missing.length - 6} more` : ''}
          <br><br>Add the photos if you can. If you genuinely can't, you can sign off
          anyway and the office will see the photos are missing.`,
        confirmText: 'Sign off without them',
        cancelText: 'Go back and add photos',
        danger: true,
      });
      if (!anyway) return;
      res = await send(true);
    }

    if (undo) {
      state.building.completed = res.completed;
      paintBuilding(state.building, locked);
      toast(`${typeLabel(type)} reopened`);
      return;
    }
    // Finishing a building ends the job, so hand them back their list
    // rather than leaving them on a checklist they are done with.
    toast(`${data.building.name} — ${typeLabel(type).toLowerCase()} complete`);
    location.hash = '#/';
  } catch (e) {
    toast(e.message, true);
  }
}

const counts = (data) => ({
  done: data.items.filter((t) => t.done).length, total: data.items.length,
});

/* --------------------------------------------------- photos on an item */

const PHOTO_BADGE = {
  required: `<span class="pill late shot-badge">${svgIcon('camera')} Photo required</span>`,
  optional: `<span class="pill idle shot-badge">${svgIcon('camera')} Photo</span>`,
};

function photoStrip(task, locked) {
  if (task.photoMode === 'none') return '';
  if (!state.config.photos) {
    // The bucket isn't bound, so there is nowhere to put a photo. Say so once
    // rather than showing a camera button that can only fail.
    return task.photoMode === 'required'
      ? `<div class="shots"><span class="tiny muted">Photo requested — photo storage
         is not set up on this site.</span></div>`
      : '';
  }

  const missing = task.photoMode === 'required' && !task.photos.length;
  return `<div class="shots${missing ? ' needed' : ''}" data-shots="${task.id}">
    ${PHOTO_BADGE[task.photoMode]}
    ${task.photos.map((p) => `<span class="shot" data-photo-id="${p.id}">
      <img alt="${esc(task.item)}" hidden data-photo="${esc(p.key)}">
      ${locked ? '' : `<button class="shot-x" data-drop="${p.id}"
        aria-label="Remove photo" title="Remove photo">${svgIcon('close')}</button>`}
    </span>`).join('')}
    ${locked ? '' : `<button class="shot-add" data-add="${task.id}">
      ${svgIcon('camera')} ${task.photos.length ? 'Add another' : 'Add photo'}
    </button>`}
  </div>`;
}

/** One tickable area of the building - "Bathrooms", "Stairwell". */
function taskRow(t, locked) {
  return `<div class="taskwrap" data-tw="${t.id}">
    <button class="task${t.done ? ' is-done' : ''}" data-t="${t.id}"
      data-done="${t.done ? 1 : 0}">
      <span class="box">${svgIcon('check')}</span>
      <span class="grow">
        <span class="item">${esc(t.item)}</span>
        <span class="desc">${esc(t.description)}</span>
        <span class="who">${t.done && t.by ? `${esc(t.by)} · ${esc(time(t.at))}` : ''}</span>
      </span>
    </button>
    ${photoStrip(t, locked)}
  </div>`;
}

/**
 * Opens the phone's photo picker. Left without `capture` on purpose: that
 * attribute forces the camera and hides the library, and half the time the
 * photo has already been taken.
 */
function pickPhotos() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.append(input);

    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      removeEventListener('focus', onFocus);
      resolve(files);
    };
    // Cancelling the picker fires no change event anywhere, so the window
    // regaining focus is the only signal that nothing is coming.
    const onFocus = () => setTimeout(() => finish([]), 600);

    input.onchange = () => finish([...input.files]);
    addEventListener('focus', onFocus, { once: true });
    input.click();
  });
}

function wireTaskPhotos(buildingId, day, locked) {
  app.querySelectorAll('[data-photo]').forEach((img) => loadPhoto(img, img.dataset.photo));
  if (locked) return;

  app.querySelectorAll('[data-add]').forEach((btn) => {
    btn.onclick = async () => {
      const taskId = Number(btn.dataset.add);
      const files = await pickPhotos();
      if (!files.length) return;

      btn.disabled = true;
      const original = btn.innerHTML;
      let added = 0;
      try {
        for (const file of files) {
          btn.innerHTML = `Uploading ${added + 1}/${files.length}…`;
          const blob = await shrinkImage(file);
          await api(`/task/photo?taskId=${taskId}&day=${day}`, {
            method: 'POST', raw: true, body: blob, contentType: 'image/jpeg',
          });
          added++;
        }
        toast(added === 1 ? 'Photo added' : `${added} photos added`);
      } catch (e) {
        toast(e.message, true);
      } finally {
        btn.disabled = false;
        btn.innerHTML = original;
      }
      if (added) await refreshBuilding(buildingId, day, state.building.cleanType, locked, true);
    };
  });

  app.querySelectorAll('[data-drop]').forEach((btn) => {
    btn.onclick = async () => {
      const go = await ask({
        title: 'Remove this photo?',
        body: 'It is deleted from storage and cannot be recovered.',
        confirmText: 'Remove',
        danger: true,
      });
      if (!go) return;
      try {
        await api('/task/photo/delete', { method: 'POST', body: { id: Number(btn.dataset.drop) } });
        toast('Photo removed');
        await refreshBuilding(buildingId, day, state.building.cleanType, locked, true);
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
}

/** Updates the summary, sign-off line and issue list from `data`, in place. */
function paintBuilding(data, locked) {
  const { done, total } = counts(data);
  const pct = total ? Math.round((done / total) * 100) : 0;

  $('#count').textContent = `${done} of ${total} done`;
  const meter = $('#meter');
  meter.classList.toggle('full', pct === 100);
  meter.firstElementChild.style.width = `${pct}%`;

  const signoff = $('#signoff');
  signoff.hidden = !data.completed;
  if (data.completed) {
    signoff.innerHTML = `<span class="pill done">${svgIcon('check')} Signed off</span>
      <span class="muted"> ${esc(typeLabel(data.cleanType))} by
      ${esc(data.completed.completed_by)} at ${esc(time(data.completed.completed_at))}</span>`;
  }

  const issues = $('#issues');
  issues.hidden = !data.issues.length;
  $('#issuelist').innerHTML = data.issues.map((i) => `<div class="list-item small">
      ${i.location ? `<strong>${esc(i.location)}</strong> — ` : ''}${esc(i.detail)}
      <div class="tiny muted">${esc(i.reported_by)} · ${esc(time(i.reported_at))}</div>
    </div>`).join('');

  if (!locked) {
    $('#complete').textContent = data.completed
      ? `Reopen this ${typeLabel(data.cleanType).toLowerCase()}`
      : `Mark ${typeLabel(data.cleanType).toLowerCase()} complete`;
  }
}

/** Polling refresh: patch the DOM rather than rebuild it, so nobody's scroll
    position or half-finished tap gets thrown away mid-shift. */
async function refreshBuilding(id, day, type, locked, force = false) {
  let data;
  try {
    data = await api(`/building?id=${id}&day=${day}&type=${type}`);
  } catch {
    return; // transient - the next tick will catch up
  }

  const shape = (d) => d.items.map((t) => `${t.id}:${t.photos.length}`).join();
  // A changed checklist (or a photo added or removed) means the markup itself
  // is out of date, so a full redraw is the only correct answer.
  if (force || shape(state.building) !== shape(data)) return renderBuilding(id, type);

  state.building = data;
  for (const task of data.items) {
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
  const task = state.building.items.find((t) => t.id === taskId);

  // Flip immediately so the tap feels instant, then reconcile with the server.
  el.classList.toggle('is-done', next);
  el.dataset.done = next ? '1' : '0';
  if (task) task.done = next;
  paintBuilding(state.building, false);

  try {
    const res = await api('/task', { method: 'POST', body: { taskId, done: next, day } });
    if (task) { task.by = res.by; task.at = res.at; }
    el.querySelector('.who').textContent = next ? `${res.by} · ${time(res.at)}` : '';

    // Nudge, not a block: ticking an item that is meant to carry a photo and
    // doesn't is the moment to say so, while they're still standing there.
    if (next && task?.photoMode === 'required' && !task.photos.length && state.config.photos) {
      toast('That item needs a photo');
      el.closest('.taskwrap')?.querySelector('[data-add]')?.focus();
    }
  } catch (e) {
    el.classList.toggle('is-done', !next);
    el.dataset.done = next ? '0' : '1';
    if (task) task.done = !next;
    paintBuilding(state.building, false);
    toast(e.message, true);
  }
}

/* ------------------------------------------------------- view: reporting */

/** `back` is where Cancel and a successful send return to - the building's
    checklist by default, or the caller's own choice (Quick report sends
    people back to where they started, not into a building they may never
    have opened). */
function renderReport(data, { back } = {}) {
  const goBack = back || (() => renderBuilding(data.building.id, data.cleanType));
  stopPolling();
  chrome({ title: 'Report', back: true });

  app.innerHTML = `<div class="card">
    <h2>${esc(data.building.name)}</h2>
    <div class="pad stack">
      <p class="small muted">Tell the office about something here that needs fixing.</p>
      <label class="field"><span>Where (optional)</span>
        <input id="where" maxlength="120" autocomplete="off"
          placeholder="Kitchen near main entrance"></label>
      <label class="field"><span>Details</span>
        <textarea id="detail"
          placeholder="${esc(REPORT_PLACEHOLDER)}"></textarea></label>
      ${state.config.photos ? `<label class="field"><span>Photo (optional)</span>
        <input type="file" id="photo" accept="image/*"></label>
        <img class="thumb" id="preview" hidden alt="">` : ''}
      <p class="err" id="err"></p>
      <button class="primary wide" id="send">Send</button>
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

  $('#cancel').onclick = goBack;

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
          location: $('#where').value,
          detail: $('#detail').value,
          photoKey,
        },
      });
      toast('Sent to the office');
      goBack();
    } catch (e) {
      $('#err').textContent = e.message;
      btn.disabled = false;
    }
  };
}

/**
 * Entry point for the Quick report shortcut (the floating + button): asks
 * which building first, then hands off to the same renderReport() every
 * other report goes through. Exists so reporting something doesn't require
 * opening that building's checklist first - useful mid-walkthrough, or for
 * a note that isn't tied to actively cleaning anywhere.
 */
async function openQuickReport() {
  let buildings;
  try {
    buildings = (await api(`/overview?day=${state.config.today}`)).buildings;
  } catch (e) {
    return toast(e.message, true);
  }

  const sheet = openSheet(`
    <div class="sheet-head"><strong>Quick report</strong></div>
    <div class="pad stack">
      <p class="small muted">Which building is this about?</p>
      <label class="field"><span>Building</span>
        <select id="qbid">
          <option value="">Choose…</option>
          ${groupBuildings(buildings).map((g) => g.buildings
            .map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')).join('')}
        </select></label>
      <p class="err" id="qerr"></p>
      <button class="primary wide" id="qgo" disabled>Continue</button>
      <button class="wide" id="qcancel">Cancel</button>
    </div>`);

  const select = sheet.querySelector('#qbid');
  const go = sheet.querySelector('#qgo');
  select.onchange = () => { go.disabled = !select.value; };
  sheet.querySelector('#qcancel').onclick = closeSheet;

  go.onclick = async () => {
    go.disabled = true;
    try {
      const data = await api(`/building?id=${select.value}&day=${state.config.today}`);
      closeSheet();
      renderReport(data, { back: () => { location.hash = '#/'; } });
    } catch (e) {
      sheet.querySelector('#qerr').textContent = e.message;
      go.disabled = false;
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
  const live = screen('#/issues');
  const { items } = await api(`/maintenance?status=${status}`);
  if (!live()) return;
  chrome({ title: 'Reports', section: 'issues' });
  const canResolve = state.user.role !== 'cleaner';

  app.innerHTML = `
    <div class="spread wrap">
      <div class="tabs">
        <button data-s="open" aria-current="${status === 'open'}">Open</button>
        <button data-s="resolved" aria-current="${status === 'resolved'}">Resolved</button>
      </div>
      <button id="newreport">${svgIcon('plus')} New report</button>
    </div>
    <div class="card">
      ${items.length ? items.map((i) => `
        <div class="list-item">
          <strong>${esc(i.building)}${i.location ? ` — ${esc(i.location)}` : ''}</strong>
          <div>${esc(i.detail)}</div>
          ${i.photo_key ? `<img class="thumb" hidden alt="Reported problem"
             data-photo="${esc(i.photo_key)}">` : ''}
          <div class="tiny muted">Reported by ${esc(i.reported_by)} on ${esc(auDate(i.day))}
            ${i.resolved_at ? ` · resolved by ${esc(i.resolved_by)}` : ''}</div>
          ${canResolve ? `<div class="gap-top-sm">
            <button class="sm" data-r="${i.id}" data-reopen="${status === 'resolved'}">
              ${status === 'resolved' ? 'Reopen' : 'Mark resolved'}</button></div>` : ''}
        </div>`).join('')
        : `<div class="empty"><b>Nothing ${status === 'open' ? 'outstanding' : 'here yet'}</b>
           ${status === 'open' ? "Everything reported so far has been dealt with." : ''}</div>`}
    </div>`;

  app.querySelectorAll('[data-photo]').forEach((img) => loadPhoto(img, img.dataset.photo));

  $('#newreport').onclick = openQuickReport;

  app.querySelectorAll('[data-s]').forEach((b) => {
    b.onclick = () => renderIssues(b.dataset.s);
  });
  app.querySelectorAll('[data-r]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/maintenance/resolve', {
          method: 'POST',
          body: { id: Number(b.dataset.r), reopen: b.dataset.reopen === 'true' },
        });
        renderIssues(status);
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
}

/** Fetches with the auth header, then hands the blob to the browser. */
async function download(path, filename) {
  try {
    const res = await request(path);
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: filename }).click();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ------------------------------------ availability editing (per person) */

/**
 * The seven rows of the availability sheet: a switch per day plus the hours.
 * Times are <input type="time">, which gives a native picker on a phone and
 * a keyboard-friendly field on the desktop, and always hands back HH:MM.
 */
function availabilityRows(days) {
  return DAY_NAMES.map((name, i) => {
    const entry = days?.[i] ?? null;
    const on = Boolean(entry);
    return `<div class="avrow ${on ? 'on' : ''}" data-avrow="${i}">
      <label class="avday">
        <input type="checkbox" ${on ? 'checked' : ''}>
        <span>${name}</span>
      </label>
      <span class="avtimes">
        <input type="time" class="avfrom" value="${esc(entry?.from ?? '')}"
          ${on ? '' : 'disabled'} aria-label="${name} start">
        <span class="tiny muted">to</span>
        <input type="time" class="avto" value="${esc(entry?.to ?? '')}"
          ${on ? '' : 'disabled'} aria-label="${name} finish">
      </span>
      <button type="button" class="iconbtn star" data-pref
        aria-pressed="${Boolean(entry?.preferred)}" ${on ? '' : 'disabled'}
        title="${name}: a day they would rather work"
        aria-label="${name}: prefers this day">${svgIcon('star')}</button>
    </div>`;
  }).join('');
}

function wireAvailabilityRows(root) {
  root.querySelectorAll('[data-avrow]').forEach((row) => {
    const box = row.querySelector('input[type="checkbox"]');
    const times = row.querySelectorAll('input[type="time"]');
    const star = row.querySelector('[data-pref]');
    box.onchange = () => {
      row.classList.toggle('on', box.checked);
      times.forEach((t) => { t.disabled = !box.checked; });
      // Preferring a day you don't work is meaningless, so the star follows
      // the switch off rather than being left set on a day that's gone.
      star.disabled = !box.checked;
      if (!box.checked) star.setAttribute('aria-pressed', 'false');
    };
    star.onclick = () => {
      star.setAttribute('aria-pressed',
        String(star.getAttribute('aria-pressed') !== 'true'));
    };
  });
}

/** Reads the sheet back into the 7 entries the API expects. */
const readAvailabilityRows = (root) => [...root.querySelectorAll('[data-avrow]')].map((row) => {
  if (!row.querySelector('input[type="checkbox"]').checked) return null;
  return {
    from: row.querySelector('.avfrom').value,
    to: row.querySelector('.avto').value,
    preferred: row.querySelector('[data-pref]').getAttribute('aria-pressed') === 'true',
  };
});

/** "Mon, Tue, Wed · 8am–4pm" style summary for a person's row. */
function availabilitySummary(person) {
  const days = person.availability;
  if (!Array.isArray(days)) return 'available every day';
  const on = days.map((d, i) => (d ? i : -1)).filter((i) => i >= 0);
  if (!on.length) return 'no days set';

  const ranges = new Set(on.map((i) => timeRange(days[i].from, days[i].to)).filter(Boolean));
  const dayText = on.length === 7 ? 'every day' : on.map((i) => DAY_NAMES[i]).join(', ');
  const preferred = on.filter((i) => days[i].preferred).map((i) => DAY_NAMES[i]);

  return [
    ranges.size ? `${dayText} · ${ranges.size === 1 ? [...ranges][0] : 'varying hours'}` : dayText,
    // Only worth saying when it narrows things - "prefers every day they work"
    // is noise.
    preferred.length && preferred.length < on.length ? `prefers ${preferred.join(', ')}` : '',
    person.idealHours ? `ideally ${person.idealHours}h a week` : '',
  ].filter(Boolean).join(' · ');
}

function editAvailability(person, onDone) {
  const sheet = openSheet(`
    <div class="sheet-head"><strong>${esc(person.name)}</strong>
      <span class="tiny muted">availability</span></div>
    <div class="pad stack">
      <p class="dialog-body">Which days <strong>can</strong> they work, and between what
        times? Leave the times blank for a day with no set hours. Tap a star for a day
        they'd <strong>rather</strong> work — that never blocks anything, it just puts
        them first when you're picking someone.</p>
      <div class="avlist">${availabilityRows(person.availability)}</div>
      <div class="row wrap tight">
        <button data-preset="copy">Copy first day down</button>
        <button data-preset="clear">Clear all</button>
      </div>

      <label class="field"><span>Ideal hours a week (optional)</span>
        <input id="avhours" type="number" min="1" max="80" step="0.5" inputmode="decimal"
          value="${esc(person.idealHours ?? '')}" placeholder="e.g. 25">
        <span class="field-hint">Shown against what they're actually rostered, so you can
          see at a glance who is short and who is over.</span></label>

      <p class="err" id="err"></p>
      <button class="primary wide" id="save">Save availability</button>
      <button class="wide" id="cancel">Cancel</button>
    </div>`);

  wireAvailabilityRows(sheet);

  const rows = () => [...sheet.querySelectorAll('[data-avrow]')];
  const setRow = (row, on, from = '', to = '') => {
    const box = row.querySelector('input[type="checkbox"]');
    box.checked = on;
    row.classList.toggle('on', on);
    row.querySelectorAll('input[type="time"]').forEach((t) => { t.disabled = !on; });
    row.querySelector('.avfrom').value = from;
    row.querySelector('.avto').value = to;
    const star = row.querySelector('[data-pref]');
    star.disabled = !on;
    if (!on) star.setAttribute('aria-pressed', 'false');
  };

  sheet.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => {
      const kind = b.dataset.preset;
      if (kind === 'clear') {
        rows().forEach((row) => setRow(row, false));
      } else {
        const first = rows()[0];
        const on = first.querySelector('input[type="checkbox"]').checked;
        const from = first.querySelector('.avfrom').value;
        const to = first.querySelector('.avto').value;
        const pref = first.querySelector('[data-pref]').getAttribute('aria-pressed') === 'true';
        rows().slice(1).forEach((row) => {
          setRow(row, on, from, to);
          row.querySelector('[data-pref]').setAttribute('aria-pressed', String(on && pref));
        });
      }
    };
  });

  sheet.querySelector('#cancel').onclick = closeSheet;
  sheet.querySelector('#save').onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await api('/availability', {
        method: 'POST',
        body: {
          userId: person.id,
          days: readAvailabilityRows(sheet),
          idealHours: sheet.querySelector('#avhours').value,
        },
      });
      closeSheet();
      toast('Availability saved');
      onDone();
    } catch (e) {
      sheet.querySelector('#err').textContent = e.message;
      ev.currentTarget.disabled = false;
    }
  };
}

/* ------------------------------------- view: everyone's availability */

async function renderAvailability() {
  const live = screen('#/availability');
  const from = weekFrom();
  const data = await api(`/availability?from=${from}`);
  if (!live()) return;
  chrome({ title: 'Availability', section: 'schedule', wide: true });

  const f = state.availFilter;
  const overlaps = (entry) => {
    if (!f.from || !f.to) return true;
    if (!entry) return false;
    if (!entry.from || !entry.to) return true; // no set hours: available whenever
    return entry.from < f.to && entry.to > f.from;
  };

  const dayMatches = (person, index) => {
    const entry = person.availability[index];
    if (f.status === 'available' && !entry) return false;
    if (f.status === 'preferred' && !entry?.preferred) return false;
    if (f.status === 'unavailable' && entry) return false;
    return overlaps(entry);
  };

  const shown = data.staff.filter((p) => {
    if (f.q && !p.name.toLowerCase().includes(f.q)) return false;
    const indexes = f.day === 'all' ? [0, 1, 2, 3, 4, 5, 6] : [Number(f.day)];
    return indexes.some((i) => dayMatches(p, i));
  });

  const dim = (person, index) =>
    (f.status === 'all' && f.day === 'all' && !f.from ? false : !dayMatches(person, index));

  app.innerHTML = `
    ${planningTabs('availability')}
    <div class="card"><div class="pad">${weekNav(from)}</div></div>

    <div class="card noprint">
      <div class="pad filters">
        <label class="field"><span>Staff member</span>
          <input id="fq" value="${esc(f.q)}" placeholder="Search by name" autocomplete="off"></label>
        <label class="field"><span>Day</span>
          <select id="fday">
            <option value="all">Every day</option>
            ${DAY_FULL.map((d, i) =>
              `<option value="${i}" ${String(i) === f.day ? 'selected' : ''}>${d}</option>`).join('')}
          </select></label>
        <label class="field"><span>Status</span>
          <select id="fstatus">
            <option value="all" ${f.status === 'all' ? 'selected' : ''}>Anyone</option>
            <option value="available" ${f.status === 'available' ? 'selected' : ''}>Available</option>
            <option value="preferred" ${f.status === 'preferred' ? 'selected' : ''}>Would rather work it</option>
            <option value="unavailable" ${f.status === 'unavailable' ? 'selected' : ''}>Unavailable</option>
          </select></label>
        <label class="field span2"><span>Free between</span>
          <span class="row tight">
            <input type="time" id="ffrom" value="${esc(f.from)}" aria-label="Available from">
            <input type="time" id="fto" value="${esc(f.to)}" aria-label="Available to">
          </span></label>
        <div class="field"><span>&nbsp;</span>
          <button class="wide" id="fclear">Clear filters</button></div>
      </div>
    </div>

    <div class="card">
      <h2>${shown.length} of ${data.staff.length} staff</h2>
      <div class="grid-wrap">
        <table class="sched avail">
          <thead><tr>
            <th class="corner">Staff</th>
            ${data.days.map((d, i) => `<th class="${d === data.today ? 'is-today' : ''}">
              ${esc(DAY_NAMES[i])}<small>${esc(dayOfMonth(d))}</small></th>`).join('')}
          </tr></thead>
          <tbody>
            ${shown.map((p) => `<tr>
              <th class="rowhead">
                <button class="linkish" data-edit="${p.id}">${esc(p.name)}</button>
                <small>${esc(p.role)}${hoursLabel(p)
                  ? ` · <span class="num ${overHours(p) ? 'over' : ''}">${esc(hoursLabel(p))}</span>`
                  : ''}</small>
              </th>
              ${p.availability.map((entry, i) => {
                const rostered = p.rostered[i];
                // A shift booked on a day off is exactly what this screen
                // exists to surface, so it is called out here too.
                const clash = rostered && !entry;
                return `<td class="${dim(p, i) ? 'dimmed' : ''}">
                  <div class="avcell ${entry ? 'yes' : 'no'}${
                    entry?.preferred ? ' preferred' : ''}">
                    ${entry?.preferred
                      ? `<span class="prefstar" title="Would rather work this day"
                          >${svgIcon('star')}</span>` : ''}
                    ${esc(availabilityText(entry))}
                    ${rostered ? `<span class="tiny ${clash ? 'clash' : 'muted'}">
                      ${rostered} shift${rostered === 1 ? '' : 's'}${
                        clash ? ' — clash' : ''}</span>` : ''}
                  </div></td>`;
              }).join('')}
            </tr>`).join('') || `<tr><td colspan="8">
              <div class="empty">Nobody matches those filters.</div></td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="legend">
        <span><i class="sw yes"></i>Available</span>
        <span><i class="sw no"></i>Unavailable</span>
        <span><span class="prefstar">${svgIcon('star')}</span>Would rather work it</span>
        <span>Tap a name to set days, hours and notes</span>
      </div>
    </div>`;

  wirePlanningTabs(app);
  wireWeekNav(app, renderAvailability);

  const setFilter = (patch) => {
    Object.assign(state.availFilter, patch);
    renderAvailability();
  };
  // Re-rendering on every keystroke would lose focus, so the name box filters
  // the rows that are already on screen and only the selects re-render.
  $('#fq').oninput = (ev) => {
    state.availFilter.q = ev.currentTarget.value.trim().toLowerCase();
    const q = state.availFilter.q;
    app.querySelectorAll('table.avail tbody tr').forEach((row) => {
      const name = row.querySelector('.rowhead')?.textContent.toLowerCase() ?? '';
      row.hidden = Boolean(q) && !name.includes(q);
    });
  };
  $('#fday').onchange = (ev) => setFilter({ day: ev.currentTarget.value });
  $('#fstatus').onchange = (ev) => setFilter({ status: ev.currentTarget.value });
  $('#ffrom').onchange = (ev) => setFilter({ from: ev.currentTarget.value });
  $('#fto').onchange = (ev) => setFilter({ to: ev.currentTarget.value });
  $('#fclear').onclick = () =>
    setFilter({ q: '', day: 'all', status: 'all', from: '', to: '' });

  app.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => editAvailability(
      data.staff.find((p) => p.id === Number(b.dataset.edit)),
      renderAvailability,
    );
  });
}

/* ------------------------------------------------------- view: the roster */

const FLAG_TEXT = {
  unavailable: 'Rostered on a day they are not available',
  outside: 'Outside the hours they are available',
  overlap: 'Overlaps another shift the same day',
};

async function renderRoster() {
  const live = screen();
  const from = weekFrom();
  const data = await api(`/roster?from=${from}&days=7`);
  if (!live()) return;
  chrome({ title: 'Staff roster', section: planningSection(), wide: true });
  const canEdit = data.canEdit;

  const shiftsFor = (userId, day) =>
    data.shifts.filter((s) => s.user_id === userId && s.day === day);

  // Only people who are on the roster this week, plus (for the office) anyone
  // who could be - a table of thirty names with two shifts in it is unusable.
  const onRoster = new Set(data.shifts.map((s) => s.user_id));
  const staff = canEdit ? data.staff : data.staff.filter((p) => onRoster.has(p.id));
  const conflicts = data.shifts.filter((s) => s.flags.length);

  const cell = (person, day) => {
    const shifts = shiftsFor(person.id, day);
    const entry = availabilityOn(person, day);
    const classes = ['cell', 'rcell', shifts.length ? 'on' : '', entry ? '' : 'off-day',
      !shifts.length && entry?.preferred ? 'wants' : '']
      .filter(Boolean).join(' ');

    const inner = shifts.length
      ? shifts.map((s) => `<span class="shift ${s.flags.length ? 'clash' : ''}">
          <b>${esc(timeRange(s.start_time, s.end_time))}</b>
          ${s.note ? `<span class="tiny" title="${esc(s.note)}">${esc(s.note)}</span>` : ''}
          ${s.flags.length
            ? `<span class="shift-marks"><span class="warnmark">${svgIcon('warning')}</span></span>`
            : ''}
        </span>`).join('')
      : entry
        ? `<span class="offtext add">${canEdit ? '+' : '—'}</span>${entry.preferred
          ? `<span class="prefstar" title="Would rather work this day"
              >${svgIcon('star')}</span>` : ''}`
        : '<span class="offtext">OFF</span>';

    return `<td class="${day === data.today ? 'today-col' : ''}">
      <button class="${classes}" data-shift="${person.id}|${day}"
        title="${esc(person.name)} — ${esc(dayLabel(day))}" ${canEdit ? '' : 'disabled'}
        >${inner}</button></td>`;
  };

  app.innerHTML = `
    ${planningTabs('roster')}
    <div class="card noprint"><div class="pad">${weekNav(from)}</div></div>

    ${conflicts.length ? `<div class="card noprint">
      <div class="banner warn">
        <strong>${conflicts.length} shift${conflicts.length === 1 ? '' : 's'} clash with
        availability.</strong>
        ${conflicts.slice(0, 4).map((s) => `${esc(s.user_name)} on
          ${esc(DAY_NAMES[weekdayIndex(s.day)])} (${esc(FLAG_TEXT[s.flags[0]].toLowerCase())})`)
          .join('; ')}${conflicts.length > 4 ? `; and ${conflicts.length - 4} more` : ''}.
      </div></div>` : ''}

    <div class="card" id="printarea">
      <h1 class="printonly print-title">Cleaning Schedule - Week Commencing ${esc(auDate(from))}</h1>
      <div class="grid-wrap">
        <table class="sched roster">
          <thead><tr>
            <th class="corner">Staff</th>
            ${data.days.map((d, i) => `<th class="${d === data.today ? 'is-today' : ''}">
              ${esc(DAY_NAMES[i])}<small>${esc(dayOfMonth(d))}</small></th>`).join('')}
          </tr></thead>
          <tbody>
            ${staff.map((p) => `<tr>
              <th class="rowhead">${esc(p.name)}
                <small>${canEdit && hoursLabel(p)
                  ? `<span class="num ${overHours(p) ? 'over' : ''}">${esc(hoursLabel(p))}</span>`
                  : esc(p.role)}</small></th>
              ${data.days.map((d) => cell(p, d)).join('')}
            </tr>`).join('') || `<tr><td colspan="8">
              <div class="empty"><b>Nobody rostered this week</b>
              ${canEdit ? 'Tap a square to add a shift.' : ''}</div></td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="printonly print-foot">
        Flagged = clashes with availability · OFF = not available</p>
    </div>

    <div class="row wrap noprint">
      <button id="print">${svgIcon('printer')} Print / save as PDF</button>
      ${canEdit ? `<button id="csv">${svgIcon('download')} Download CSV</button>
      <button id="copyweek">${svgIcon('copy')} Copy last week into this one</button>` : ''}
    </div>

    <p class="tiny muted center noprint">
      ${canEdit
        ? 'Tap any square to add or change a shift. Shifts that clash with someone\'s '
          + 'availability are flagged rather than blocked.'
        : 'This is the roster the office has set.'}</p>`;

  wirePlanningTabs(app);
  wireWeekNav(app, renderRoster);

  $('#print').onclick = () => window.print();
  $('#csv')?.addEventListener('click', () =>
    download(`/roster/export?from=${from}`, `roster-week-${auDate(from)}.csv`));

  $('#copyweek')?.addEventListener('click', async () => {
    const go = await ask({
      title: 'Copy last week?',
      body: `Every shift from the week of <strong>${esc(auDate(addDays(from, -7)))}</strong>
        is copied into this one, ready to adjust.
        This only works while this week is empty.`,
      confirmText: 'Copy them across',
    });
    if (!go) return;
    try {
      const res = await api('/roster/copy', {
        method: 'POST', body: { from: addDays(from, -7), to: from },
      });
      toast(`${res.copied} shift${res.copied === 1 ? '' : 's'} copied`);
      renderRoster();
    } catch (e) {
      toast(e.message, true);
    }
  });

  if (canEdit) {
    app.querySelectorAll('[data-shift]').forEach((b) => {
      b.onclick = () => {
        const [uid, day] = b.dataset.shift.split('|');
        openShiftEditor(data, Number(uid), day);
      };
    });
  }
}

/** Add, change or delete the shifts one person has on one day. */
function openShiftEditor(data, userId, day) {
  const person = data.staff.find((p) => p.id === userId);
  const existing = data.shifts.filter((s) => s.user_id === userId && s.day === day);
  const entry = availabilityOn(person, day);
  const suggested = entry && entry.from
    ? { from: entry.from, to: entry.to }
    : { from: '08:00', to: '16:00' };

  const draw = (shift, forceForm = false) => {
    const sheet = openSheet(`
      <div class="sheet-head">
        <div>
          <strong>${esc(person.name)}</strong>
          <div class="small muted">${esc(DAY_FULL[weekdayIndex(day)])} ${esc(auDate(day))}</div>
        </div>
        <span class="pill ${entry ? (entry.preferred ? 'open' : 'done') : 'late'}">${
          entry?.preferred ? 'Prefers this day · ' : ''}${esc(availabilityText(entry))}</span>
      </div>
      <div class="pad stack">
        ${hoursLabel(person) ? `<p class="note">
          <strong class="num">${esc(hoursLabel(person))}</strong> rostered this week.</p>` : ''}
        ${existing.length && !shift && !forceForm ? `<div class="stack">
          ${existing.map((s) => `<div class="list-item shiftrow">
            <div class="spread wrap">
              <span class="grow"><strong>${esc(timeRange(s.start_time, s.end_time))}</strong>
                ${s.flags.map((fl) => `<span class="pill late" title="${esc(FLAG_TEXT[fl])}"
                  >${svgIcon('warning')} ${esc(fl)}</span>`).join('')}
                ${s.note ? `<span class="tiny muted">${esc(s.note)}</span>` : ''}
              </span>
              <span class="row tight">
                <button class="ghost" data-editshift="${s.id}">Edit</button>
                <button class="ghost danger" data-delshift="${s.id}">Delete</button>
              </span>
            </div>
          </div>`).join('')}
          <button class="primary wide" data-new>Add another shift</button>
          <button class="wide" data-close>Close</button>
        </div>` : `
          <label class="field"><span>Start</span>
            <input type="time" id="sfrom" value="${esc(shift?.start_time ?? suggested.from)}"></label>
          <label class="field"><span>Finish</span>
            <input type="time" id="sto" value="${esc(shift?.end_time ?? suggested.to)}"></label>
          <label class="field"><span>Notes (optional)</span>
            <input id="snote" maxlength="200" value="${esc(shift?.note ?? '')}"
              placeholder="Finishing early — dentist"></label>
          <p class="err" id="err"></p>
          <button class="primary wide" id="save">${shift ? 'Save shift' : 'Add shift'}</button>
          ${shift ? `<button class="wide danger" data-delshift="${shift.id}">Delete shift</button>` : ''}
          <button class="wide" data-close>Cancel</button>`}
      </div>`);

    sheet.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeSheet; });
    sheet.querySelector('[data-new]')?.addEventListener('click', () => draw(null, true));
    sheet.querySelectorAll('[data-editshift]').forEach((b) => {
      b.onclick = () => draw(existing.find((s) => s.id === Number(b.dataset.editshift)));
    });

    sheet.querySelectorAll('[data-delshift]').forEach((b) => {
      b.onclick = async () => {
        const go = await ask({
          title: 'Delete this shift?',
          body: 'It comes off the roster. Nothing else is affected.',
          confirmText: 'Delete',
          danger: true,
        });
        if (!go) return;
        try {
          await api('/roster/delete', { method: 'POST', body: { id: Number(b.dataset.delshift) } });
          closeSheet();
          toast('Shift deleted');
          renderRoster();
        } catch (e) {
          toast(e.message, true);
        }
      };
    });

    sheet.querySelector('#save')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      const payload = {
        id: shift?.id,
        userId,
        day,
        start: sheet.querySelector('#sfrom').value,
        end: sheet.querySelector('#sto').value,
        note: sheet.querySelector('#snote').value,
      };

      try {
        await api('/roster', { method: 'POST', body: payload });
      } catch (e) {
        // Availability clashes come back as a 409 with the reasons listed, so
        // the office is told exactly what is wrong before choosing to go ahead.
        if (e.status === 409 && e.data.conflicts) {
          const anyway = await ask({
            title: 'That clashes with their availability',
            body: e.data.conflicts.map((c) => esc(c.message)).join('<br>')
              + '<br><br>You can roster it anyway — it stays flagged on the roster so '
              + 'nobody forgets.',
            confirmText: 'Roster anyway',
            cancelText: 'Change the times',
            danger: true,
          });
          if (!anyway) { btn.disabled = false; return; }
          try {
            await api('/roster', { method: 'POST', body: { ...payload, force: true } });
          } catch (err) {
            sheet.querySelector('#err').textContent = err.message;
            btn.disabled = false;
            return;
          }
        } else {
          sheet.querySelector('#err').textContent = e.message;
          btn.disabled = false;
          return;
        }
      }

      closeSheet();
      toast(shift ? 'Shift updated' : 'Shift added');
      renderRoster();
    });
  };

  draw(null);
}

/* ------------------------------------------ view: checklist editor (admin) */

/** The Full Clean / Check tab strip, shared by both admin checklist screens. */
function typeTabs(current) {
  return `<div class="seg">${CLEAN_TYPES().map((t) => `
    <button type="button" class="seg-btn" data-settype="${esc(t.id)}"
      aria-pressed="${t.id === current}">${esc(t.label)}</button>`).join('')}</div>`;
}

function wireTypeTabs(root, rerender) {
  root.querySelectorAll('[data-settype]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.settype === state.editType) return;
      state.editType = b.dataset.settype;
      rerender();
    };
  });
}

async function renderChecklistAdmin() {
  const live = screen('#/buildings');
  const type = state.editType;
  const data = await api(`/admin/checklist?type=${type}`);
  if (!live()) return;
  chrome({ title: 'Checklists', section: 'buildings', wide: true });
  const itemsFor = (id) => (data.items[id] ?? []).filter((t) => t.active);

  const groups = groupBuildings(data.buildings);

  const buildingRow = (b, groupKey, folded) => {
    const items = itemsFor(b.id);
    const search = [b.name, b.grp, ...items.map((t) => t.item)].join(' ').toLowerCase();
    return `<button class="list-item brow" data-open="${b.id}" data-search="${esc(search)}"
        data-group="${esc(groupKey)}" ${folded ? 'hidden' : ''}
        data-off="${b.active ? 0 : 1}">
      <div class="spread wrap">
        <strong class="grow">${esc(b.name)}
          ${b.active ? '' : '<span class="pill idle">hidden</span>'}</strong>
        <span class="muted">${svgIcon('chevron')}</span>
      </div>
      <div class="small muted">
        ${items.length ? esc(items.map((t) => t.item).join(' · '))
          : '<span class="pill late">empty</span>'}
      </div>
      <div class="tiny muted">
        ${items.length} on the ${esc(typeLabel(type))} ·
        ${data.otherCounts[b.id] ?? 0} on the ${esc(typeLabel(otherType(type)))}
      </div>
    </button>`;
  };

  /** Re-applies search-match and fold state together, so folding a group
      that's mid-search doesn't fight with the search filter. */
  function applyChecklistFilter(q) {
    app.querySelectorAll('[data-search]').forEach((el) => {
      const matches = !q || el.dataset.search.includes(q);
      const folded = !q && state.collapsedGroups.has(el.dataset.group);
      el.hidden = !matches || folded;
    });
    app.querySelectorAll('.grouphead').forEach((head) => {
      if (!q) { head.hidden = false; return; }
      let sib = head.nextElementSibling;
      let anyVisible = false;
      while (sib && sib.matches('[data-search]')) {
        if (!sib.hidden) anyVisible = true;
        sib = sib.nextElementSibling;
      }
      head.hidden = !anyVisible;
    });
  }

  const empties = data.buildings.filter((b) => b.active && !itemsFor(b.id).length);

  app.innerHTML = `
    <div class="card">
      <div class="banner ${data.source === 'app' && data.fileDiffers ? 'warn'
        : data.source === 'app' ? 'info' : 'warn'}">
        ${data.source === 'app' && data.fileDiffers
          ? `<strong>The checklist file has changed, and it is not being applied.</strong>
             These checklists were edited in the app, so <code>data/checklist.json</code>
             stopped overwriting them. To take what the file now says, use
             <strong>Restore from the checklist file</strong> at the bottom of this page.`
          : data.source === 'app'
            ? `<strong>Edited in the app.</strong> These checklists are now managed here, and
               <code>data/checklist.json</code> no longer overwrites them on deploy.`
            : `<strong>Managed by the checklist file.</strong> The first edit you make here
               takes over, and <code>data/checklist.json</code> stops being applied — so a
               later deploy can't quietly undo your work.`}
      </div>
    </div>

    <div class="card">
      <div class="pad">${typeTabs(type)}</div>
      <div class="pad">
        <input id="search" placeholder="Search buildings or checklist items…" autocomplete="off">
      </div>
      <h2>
        ${esc(typeLabel(type))} — ${data.buildings.filter((b) => b.active).length} buildings</h2>
      ${empties.length ? `<div class="pad">
        <div class="banner warn">
          <strong>${empties.length} building${empties.length === 1 ? ' has' : 's have'} no
          ${esc(typeLabel(type))} checklist:</strong>
          ${empties.slice(0, 6).map((b) => esc(b.name)).join(', ')}${
            empties.length > 6 ? `, and ${empties.length - 6} more` : ''}.
          Open one and use <strong>Add the ${esc(typeLabel(otherType(type)))} list</strong>
          to start it off.
        </div></div>` : ''}
      ${groups.map((g) => {
        const folded = g.label && state.collapsedGroups.has(g.key);
        const head = g.label ? `<button class="grouphead" data-grouptoggle="${esc(g.key)}"
            aria-expanded="${!folded}">
          ${svgIcon('chevron', 'chev')}
          <span class="grow">${esc(g.label)}</span>
          <span class="num">${g.buildings.length}</span>
        </button>` : '';
        return head + g.buildings.map((b) => buildingRow(b, g.key, folded)).join('');
      }).join('')}
      <div class="pad row wrap">
        <button class="primary" id="addb">${svgIcon('plus')} Add a building</button>
        <button id="orderb">Reorder buildings</button>
      </div>
    </div>

    <div class="card danger">
      <h2>Restore from the checklist file</h2>
      <div class="pad">
        <p class="small muted">Throws away edits made here and
          rebuilds <strong>both</strong> checklists from <code>data/checklist.json</code>.
          Cleaning history is not affected.</p>
        <button class="wide danger" id="restore">Restore from file</button>
      </div>
    </div>`;

  wireTypeTabs(app, renderChecklistAdmin);

  app.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = () => { location.hash = `#/buildings/${b.dataset.open}`; };
  });
  $('#addb').onclick = () => editBuilding(null, renderChecklistAdmin);
  $('#orderb').onclick = () => openReorder({
    title: 'Reorder buildings',
    hint: 'This is the order buildings appear on the schedule, the overview and every list.',
    items: data.buildings.map((b) => ({ id: b.id, label: b.name, sub: b.grp })),
    kind: 'buildings',
    onDone: renderChecklistAdmin,
  });

  $('#search').oninput = (ev) => applyChecklistFilter(ev.currentTarget.value.trim().toLowerCase());

  app.querySelectorAll('[data-grouptoggle]').forEach((head) => {
    wireGroupToggle(head, head.dataset.grouptoggle, () => {
      applyChecklistFilter($('#search').value.trim().toLowerCase());
    });
  });

  $('#restore').onclick = async () => {
    const typed = await askText({
      title: 'Restore from the checklist file?',
      body: 'Every building and every item on <strong>both</strong> checklists goes back to '
        + 'what <code>data/checklist.json</code> says. Anything you added here that is not in '
        + 'the file will be hidden. Cleaning records are kept.',
      label: 'Type "restore" to confirm',
      confirmText: 'Restore',
    });
    if (!typed) return;
    try {
      const r = await api('/admin/checklist/restore', { method: 'POST', body: { confirm: typed } });
      toast(`Restored ${r.buildings} buildings — ${r.added} added, ${r.updated} updated`);
      renderChecklistAdmin();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * One building's checklist on one page: the areas it is ticked off in, in
 * order, and the controls to add, edit, reorder and remove them. The list is
 * short by design - what an area covers is the note under it, not a box of
 * its own.
 */
async function renderBuildingEditor(buildingId) {
  const live = screen('#/buildings/');
  const type = state.editType;
  const data = await api(`/admin/checklist?type=${type}`);
  if (!live()) return;
  const building = data.buildings.find((b) => b.id === buildingId);
  if (!building) {
    chrome({ title: 'Not found', back: true, section: 'buildings' });
    app.innerHTML = '<div class="card pad"><p class="err">That building no longer exists.</p></div>';
    return;
  }

  chrome({ title: building.name, back: true, section: 'buildings', wide: true });

  const items = data.items[buildingId] ?? [];
  const live_ = items.filter((t) => t.active);
  // Most buildings walk the same areas either way, so every entry is on both
  // and saying so on every row is noise. The badge only earns its place once
  // this building's two lists actually differ.
  const mixed = items.some((t) => t.clean_type !== 'both');

  const PHOTO_LABEL = {
    none: '',
    optional: `<span class="pill idle">${svgIcon('camera')} photo</span>`,
    required: `<span class="pill late">${svgIcon('camera')} required</span>`,
  };

  const itemRow = (t, i) => `<div class="list-item itemrow" data-off="${t.active ? 0 : 1}">
    <div class="spread wrap">
      <span class="grow">
        <strong>${esc(t.item)}</strong>
        ${mixed && t.clean_type === 'both'
          ? '<span class="pill open">on both checklists</span>' : ''}
        ${PHOTO_LABEL[t.photo_mode] ?? ''}
        ${t.active ? '' : '<span class="pill idle">hidden</span>'}
        <span class="small muted">${esc(t.description)}</span>
        ${t.history ? `<span class="tiny muted">${t.history} record${
          t.history === 1 ? '' : 's'}</span>` : ''}
      </span>
      <span class="row tight">
        <button class="iconbtn" data-move="${t.id}" data-dir="-1"
          ${i === 0 ? 'disabled' : ''} aria-label="Move up" title="Move up"
          >${svgIcon('up')}</button>
        <button class="iconbtn" data-move="${t.id}" data-dir="1"
          ${i === items.length - 1 ? 'disabled' : ''}
          aria-label="Move down" title="Move down">${svgIcon('down')}</button>
        <button class="sm" data-edititem="${t.id}">Edit</button>
      </span>
    </div>
  </div>`;

  app.innerHTML = `
    <div class="card">
      <div class="pad">${typeTabs(type)}</div>
      <div class="pad spread wrap">
        <div>
          <strong>${esc(building.name)}</strong>
          <div class="small muted">${
            building.grp && building.grp !== building.name ? `${esc(building.grp)} · ` : ''}${
            live_.length} thing${live_.length === 1 ? '' : 's'} to tick off
            on the ${esc(typeLabel(type))}</div>
        </div>
        <button id="editb">Edit building</button>
      </div>
    </div>

    <div class="card">
      ${items.length
        ? items.map(itemRow).join('')
        : `<div class="empty">
            <b>No ${esc(typeLabel(type))} checklist yet</b>
            Add an area, or bring the ${esc(typeLabel(otherType(type)))} list across.
          </div>`}
      <div class="pad row wrap">
        <button class="primary" id="additem">${svgIcon('plus')} Add an area</button>
        ${items.length > 1 ? '<button id="orderitems">Reorder</button>' : ''}
        <button id="copyover">${svgIcon('copy')} Add the ${
          esc(typeLabel(otherType(type)))} list</button>
      </div>
      <p class="tiny muted pad">
        Broad areas, not individual jobs — "Bathrooms", not "clean the sinks". Hiding one
        takes it off future checklists and keeps every record of it having been cleaned;
        deleting throws those records away.</p>
    </div>

    <div class="card danger">
      <h2>Delete this building</h2>
      <div class="pad">
        <p class="small muted">Removes <strong>${esc(building.name)}</strong>,
          both of its checklists, every tick, every photo, its schedule and its reports.
          <strong>There is no undo.</strong> To take it off the schedule but keep its history,
          use <strong>Edit building</strong> and turn it off instead.</p>
        <button class="wide danger" id="delb">Delete building permanently</button>
      </div>
    </div>`;

  wireTypeTabs(app, () => renderBuildingEditor(buildingId));
  const again = () => renderBuildingEditor(buildingId);

  $('#editb').onclick = () => editBuilding(building, again);
  $('#additem').onclick = () => editTask({ building_id: buildingId, clean_type: type }, again);

  $('#orderitems')?.addEventListener('click', () => openReorder({
    title: 'Reorder',
    hint: `The order they appear on the ${typeLabel(type)} checklist.`,
    items: items.map((t) => ({
      id: t.id, label: t.item, sub: t.active ? '' : 'hidden',
    })),
    kind: 'items',
    parentId: buildingId,
    cleanType: type,
    onDone: again,
  }));

  app.querySelectorAll('[data-edititem]').forEach((b) => {
    b.onclick = () => editTask(
      items.find((t) => t.id === Number(b.dataset.edititem)), again,
    );
  });

  // One-tap nudge up or down, which is what people actually reach for when a
  // single item is in the wrong place.
  app.querySelectorAll('[data-move]').forEach((b) => {
    b.onclick = async () => {
      const dir = Number(b.dataset.dir);
      const ids = items.map((t) => t.id);
      const at = ids.indexOf(Number(b.dataset.move));
      if (at < 0 || at + dir < 0 || at + dir >= ids.length) return;
      [ids[at], ids[at + dir]] = [ids[at + dir], ids[at]];
      try {
        await api('/admin/reorder', {
          method: 'POST', body: { kind: 'items', parentId: buildingId, cleanType: type, ids },
        });
        again();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });

  $('#copyover').onclick = async () => {
    const source = otherType(type);
    const go = await ask({
      title: `Add the ${typeLabel(source)} list to this one?`,
      body: `Everything on the <strong>${esc(typeLabel(source))}</strong> checklist for
        ${esc(building.name)} is put on the <strong>${esc(typeLabel(type))}</strong> as well,
        ready to trim down. Anything already on this checklist is left alone — nothing is
        doubled up, and nothing comes off the ${esc(typeLabel(source))}.`,
      confirmText: 'Add them',
    });
    if (!go) return;
    try {
      const res = await api('/admin/checklist/copy', {
        method: 'POST', body: { buildingId, from: source, to: type },
      });
      toast(`${res.items} added to the ${typeLabel(type)}`);
      again();
    } catch (e) {
      toast(e.message, true);
    }
  };

  $('#delb').onclick = async () => {
    const typed = await askText({
      title: `Delete "${building.name}"?`,
      body: `This deletes the building, both checklists, every item, every photo and every day
             any of it was ever ticked. <strong>This cannot be undone.</strong>`,
      label: 'Type the building name to confirm',
      confirmText: 'Delete permanently',
      danger: true,
    });
    if (typed === null) return;
    try {
      await api('/admin/building/delete', {
        method: 'POST', body: { id: buildingId, confirm: typed },
      });
      toast(`${building.name} deleted`);
      location.hash = '#/buildings';
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * Generic reorder sheet: move rows with the buttons, save once. The whole
 * ordered list goes to the server, which refuses it if anything was added or
 * removed in the meantime rather than writing a stale order over the top.
 */
function openReorder({ title, hint, items, kind, parentId, cleanType, onDone }) {
  const order = [...items];

  const sheet = openSheet(`
    <div class="sheet-head"><strong>${esc(title)}</strong></div>
    <div class="pad stack">
      <p class="dialog-body">${esc(hint)}</p>
      <div class="reorder" id="rows"></div>
      <p class="err" id="err"></p>
      <button class="primary wide" id="save">Save this order</button>
      <button class="wide" id="cancel">Cancel</button>
    </div>`);

  const rows = sheet.querySelector('#rows');
  const draw = () => {
    rows.innerHTML = order.map((item, i) => `<div class="reorder-row">
      <span class="grow">
        <strong>${esc(item.label)}</strong>
        ${item.sub ? `<span class="tiny muted">${esc(item.sub)}</span>` : ''}
      </span>
      <button class="iconbtn" data-up="${i}" ${i === 0 ? 'disabled' : ''}
        aria-label="Move up">${svgIcon('up')}</button>
      <button class="iconbtn" data-down="${i}" ${i === order.length - 1 ? 'disabled' : ''}
        aria-label="Move down">${svgIcon('down')}</button>
    </div>`).join('');

    rows.querySelectorAll('[data-up]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.up);
        [order[i - 1], order[i]] = [order[i], order[i - 1]];
        draw();
      };
    });
    rows.querySelectorAll('[data-down]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.down);
        [order[i + 1], order[i]] = [order[i], order[i + 1]];
        draw();
      };
    });
  };
  draw();

  sheet.querySelector('#cancel').onclick = closeSheet;
  sheet.querySelector('#save').onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await api('/admin/reorder', {
        method: 'POST',
        body: { kind, parentId, cleanType, ids: order.map((i) => i.id) },
      });
      closeSheet();
      toast('Order saved');
      onDone();
    } catch (e) {
      sheet.querySelector('#err').textContent = e.message;
      ev.currentTarget.disabled = false;
    }
  };
}

function editBuilding(b, onDone) {
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
            <span class="tiny muted">Turning this off hides it
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
      onDone();
    } catch (e) {
      sheet.querySelector('#err').textContent = e.message;
      ev.currentTarget.disabled = false;
    }
  };
}

function editTask(t, onDone) {
  const mode = t?.photo_mode ?? 'none';
  const current = t?.clean_type ?? state.editType;
  const PHOTO_CHOICES = [
    ['none', 'No photo', 'Just a tick box'],
    ['optional', 'Photo allowed', 'They can attach one if it helps'],
    ['required', 'Photo required', 'Flagged at sign-off if missing'],
  ];

  const sheet = openSheet(`
    <div class="sheet-head"><strong>${t?.id ? 'Edit area' : 'Add an area'}</strong></div>
    <div class="pad stack">
      <label class="field"><span>Name</span>
        <input id="ti" value="${esc(t?.item ?? '')}" placeholder="Bathrooms"></label>
      <label class="field"><span>Note (optional)</span>
        <input id="td" value="${esc(t?.description ?? '')}"
          placeholder="Both blocks, including the outside tap"></label>

      <div class="field"><span>Which checklist is it on?</span>
        <div class="seg" id="itemType">
          ${[...CLEAN_TYPES(), { id: 'both', label: 'Both' }].map((c) => `
            <button type="button" class="seg-btn" data-atype="${esc(c.id)}"
              aria-pressed="${c.id === current}">${esc(c.label)}</button>`).join('')}
        </div>
        <p class="tiny muted">"Both" is for anything done on every
          visit — edit it once and it stays the same on each checklist.</p>
      </div>

      <div class="field"><span>Photo</span>
        <div class="check-list">
          ${PHOTO_CHOICES.map(([id, label, hint]) => `
            <label class="check-row ${id === mode ? 'on' : ''}" data-photo="${id}">
              <input type="radio" name="photomode" ${id === mode ? 'checked' : ''}>
              <span class="grow">${esc(label)}
                <span class="tiny muted">${esc(hint)}</span></span>
            </label>`).join('')}
        </div>
      </div>

      ${t?.id ? `<label class="check-row ${t.active ? 'on' : ''}" data-act>
          <input type="checkbox" ${t.active ? 'checked' : ''}>
          <span class="grow">Show on the checklist
            <span class="tiny muted">Hiding keeps every record of it
              having been cleaned — this is the usual way to retire an item.</span></span>
        </label>` : ''}
      <p class="err" id="err"></p>
      <button class="primary wide" id="save">${t?.id ? 'Save' : 'Add it'}</button>
      ${t?.id ? '<button class="wide danger" id="del">Delete this</button>' : ''}
      <button class="wide" id="cancel">Cancel</button>
    </div>`);

  let cleanType = current;
  sheet.querySelectorAll('[data-atype]').forEach((b) => {
    b.onclick = () => {
      cleanType = b.dataset.atype;
      sheet.querySelectorAll('[data-atype]').forEach((x) =>
        x.setAttribute('aria-pressed', String(x === b)));
    };
  });

  let photoMode = mode;
  sheet.querySelectorAll('[data-photo]').forEach((row) => {
    row.querySelector('input').onchange = () => {
      photoMode = row.dataset.photo;
      sheet.querySelectorAll('[data-photo]').forEach((x) => x.classList.toggle('on', x === row));
    };
  });

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
          buildingId: t?.building_id,
          cleanType,
          item: sheet.querySelector('#ti').value,
          description: sheet.querySelector('#td').value,
          photoMode,
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

  sheet.querySelector('#del')?.addEventListener('click', async () => {
    const send = (acknowledgeHistory) =>
      api('/admin/task/delete', { method: 'POST', body: { id: t.id, acknowledgeHistory } });

    try {
      await send();
    } catch (e) {
      // Anything with history behind it needs a second, informed yes - the
      // number of records is quoted back so the choice is made knowing it.
      if (e.status !== 409 || !e.data.history) {
        toast(e.message, true);
        return;
      }
      const go = await ask({
        title: `Delete "${t.item}"?`,
        body: `It has <strong>${e.data.history}</strong> record${e.data.history === 1 ? '' : 's'}
          against it — ticks and photos from days it was cleaned. Deleting throws those away too.
          <br><br><strong>Hiding it instead keeps all of them</strong> and takes it off future
          checklists, which is almost always what you want.`,
        confirmText: 'Delete it and its records',
        cancelText: 'Keep it',
        danger: true,
      });
      if (!go) return;
      try {
        await send(e.data.history);
      } catch (err) {
        toast(err.message, true);
        return;
      }
    }
    closeSheet();
    toast(`${t.item} deleted`);
    onDone();
  });
}

/* ---------------------------------------------------------- view: admin */

async function renderAdmin() {
  const live = screen('#/admin');
  chrome({ title: 'People', section: 'admin' });
  const [{ users }, notif] = await Promise.all([
    api('/users'),
    api('/admin/notifications'),
  ]);
  if (!live()) return;

  app.innerHTML = `
    <div>
      <div class="card">
        <h2>Add someone</h2>
        <div class="pad stack narrow">
          <label class="field"><span>Name</span><input id="n"></label>
          <label class="field"><span>Role</span>
            <select id="r">
              <option value="cleaner">Cleaner — ticks checklists</option>
              <option value="office">Office — sees the overview, sets the schedule and roster</option>
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
        ${users.map((u) => `<div class="list-item people-row" data-off="${u.active ? 0 : 1}"
            data-id="${u.id}" data-name="${esc(u.name)}" data-role="${esc(u.role)}"
            data-active="${u.active}">
          <div class="row loose">
            ${avatar(u.name)}
            <span class="grow">
              <strong>${esc(u.name)}</strong>
              <span class="tiny muted">${esc(u.role)}${u.active ? '' : ' · disabled'}</span>
            </span>
          </div>
          <div class="people-avail">${esc(availabilitySummary(u))}</div>
          <div class="actions">
            <button data-days>Availability</button>
            <button data-pin>New PIN</button>
            <button data-tog>${u.active ? 'Disable' : 'Enable'}</button>
            <button class="danger" data-del
              ${u.id === state.user.id ? 'disabled title="You cannot delete yourself"' : ''}
              >Delete</button>
          </div>
        </div>`).join('')}
        <p class="note pad">
          PINs are stored hashed — they can be replaced, never read back.
          Availability feeds the roster; see <strong>Planning, then Availability,</strong>
          for everyone at once.</p>
      </div>
    </div>

    <div class="card">
      <h2>Sign-in</h2>
      <label class="switch-row">
        <input type="checkbox" id="quick" ${state.config.quickSignin ? 'checked' : ''}>
        <span class="grow">
          <strong>Test mode — tap a name to sign in</strong>
          <span class="small muted">Skips the PIN entirely. Handy while you set things up.
            <strong>Anyone with the link can sign in as anyone, including you.</strong>
            Turn it off before the cleaners start using it for real.</span>
        </span>
      </label>
    </div>

    <div class="card">
      <h2>Maintenance alerts</h2>
      <div class="pad stack narrow">
        <p class="small muted">Push a free phone notification the moment a
          cleaner reports something that needs fixing. Uses
          <strong>ntfy.sh</strong> — no account, no cost, but the topic name below is the
          <em>only</em> thing keeping your alerts private, so don't share it anywhere public.</p>
        <label class="field"><span>Topic</span>
          <input id="ntfyTopic" value="${esc(notif.topic)}" autocomplete="off"
            placeholder="not set — alerts are off" spellcheck="false"></label>
        <div class="row">
          <button class="ghost" id="ntfyGen">Generate a private topic</button>
          <button class="primary" id="ntfySave">Save</button>
        </div>
        <p class="err" id="ntfyErr"></p>
        ${notif.topic ? `<button class="ghost wide" id="ntfyTest">Send a test notification</button>`
          : ''}
        <div class="banner info">
          <strong>To receive alerts:</strong> install the free <strong>ntfy</strong> app
          (search "ntfy" on the App Store or Google Play), tap <strong>+</strong>, and
          subscribe to <code>${esc(notif.topic || 'your-topic-here')}</code> — exactly as
          shown above, on ${esc(new URL(notif.server).host)}.
        </div>
      </div>
    </div>

    <div class="card danger">
      <h2>Danger zone</h2>
      <div class="pad stack">
        <p class="small muted">
          Clears every cleaning record, schedule, roster, sign-off, photo and maintenance
          report so you can start fresh after testing. Your buildings and checklists are
          <strong>not</strong> touched. Tables are never deleted.</p>
        <label class="check-row" id="peoplerow">
          <input type="checkbox" id="wipepeople">
          <span class="grow">Also remove everyone except me
            <span class="tiny muted">You stay signed in as admin.</span></span>
        </label>
        <label class="field"><span>Type <code class="phrase">clear database</code> to confirm</span>
          <input id="confirm" placeholder="clear database" autocapitalize="none"
            autocomplete="off" spellcheck="false"></label>
        <p class="err" id="reseterr"></p>
        <button class="destroy wide" id="reset" disabled>Clear the database</button>
      </div>
    </div>`;

  $('#add').onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      await api('/users', {
        method: 'POST',
        body: { name: $('#n').value, role: $('#r').value, pin: $('#p').value },
      });
      toast('Person added');
      renderAdmin();
    } catch (e) {
      $('#err').textContent = e.message;
      btn.disabled = false;
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

  // A short random string is plenty - it only needs to be unguessable, not
  // cryptographically strong, since worst case someone sees a maintenance alert.
  $('#ntfyGen').onclick = () => {
    const random = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    $('#ntfyTopic').value = `basecamp-${random}`;
  };

  $('#ntfySave').onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      await api('/admin/notifications', {
        method: 'POST', body: { topic: $('#ntfyTopic').value.trim() },
      });
      toast('Saved');
      renderAdmin();
    } catch (e) {
      $('#ntfyErr').textContent = e.message;
      btn.disabled = false;
    }
  };

  $('#ntfyTest')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await api('/admin/notifications/test', { method: 'POST' });
      toast('Sent — check your phone');
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send a test notification';
    }
  });

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
      body: `This deletes every tick, photo, sign-off, schedule, roster and report${alsoPeople
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
      toast(`Database cleared${res.removedPeople ? ` · ${res.removedPeople} people removed` : ''}`);
      location.hash = '#/';
    } catch (e) {
      $('#reseterr').textContent = e.message;
      resetBtn.disabled = !phraseOk();
    }
  };

  const rowOf = (btn) => btn.closest('.people-row').dataset;

  app.querySelectorAll('[data-days]').forEach((b) => {
    b.onclick = () => {
      const person = users.find((u) => u.id === Number(rowOf(b).id));
      editAvailability(person, renderAdmin);
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
        body: `They will be removed from the people list, taken off any buildings they are
               assigned to, and <strong>every shift they have on the roster is deleted</strong>.
               What they have already cleaned stays in the records under their name.
               Disabling instead keeps the account and blocks sign-in.`,
        confirmText: 'Delete permanently',
        danger: true,
      });
      if (!go) return;
      try {
        const res = await api('/users/delete', { method: 'POST', body: { id: Number(row.id) } });
        toast(`${row.name} deleted${res.removedShifts
          ? ` · ${res.removedShifts} upcoming shift${res.removedShifts === 1 ? '' : 's'} removed`
          : ''}`);
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
  await refreshToken();
}

/**
 * Trades a token that is a month old for a new one.
 *
 * A phone in regular use therefore never reaches the expiry and never asks for
 * a PIN a second time; one that stops being used runs out on its own. A
 * failure here is deliberately quiet - the old token is still good, and the
 * next load will try again.
 */
async function refreshToken() {
  if (!state.token) return;
  const issued = Number(localStorage.getItem('bc.tokenAt') || 0);
  if (issued && Date.now() - issued < 30 * 86400_000) return;
  try {
    const { token, user } = await api('/session/refresh', { method: 'POST' });
    state.token = token;
    state.user = user;
    localStorage.setItem('bc.token', token);
    localStorage.setItem('bc.tokenAt', String(Date.now()));
    localStorage.setItem('bc.user', JSON.stringify(user));
  } catch { /* the token we have still works */ }
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

  const [head, arg, extra] = location.hash.replace(/^#\/?/, '').split('/');

  try {
    // Inside the try: a throw out here would be an unhandled rejection, which
    // leaves the page on its boot screen with nothing said anywhere.
    if (!state.token || !state.user) return await renderLogin();
    if (head === 'b' && arg) return await renderBuilding(Number(arg), extra);
    if (head === 'schedule') return await renderSchedule();
    if (head === 'roster') return await renderRoster();
    if (head === 'availability') {
      if (state.user.role === 'cleaner') return await renderRoster();
      return await renderAvailability();
    }
    if (head === 'issues') return await renderIssues();
    if (head === 'admin') return await renderAdmin();
    if (head === 'buildings') return arg
      ? await renderBuildingEditor(Number(arg))
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

// The service worker is registered from index.html, not here: registering it
// from this file meant a broken app.js could never replace a broken worker,
// which is how a bad cached response turns into a permanently stuck app.

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
