/* Basecamp Cleaning Tracker - front end.
   No framework, no build step. Hash routing, optimistic ticks, light polling. */

'use strict';

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const bar = $('#bar');

const state = {
  token: localStorage.getItem('bc.token') || '',
  user: JSON.parse(localStorage.getItem('bc.user') || 'null'),
  config: null,
  configAt: 0,
  day: null,       // day being viewed; null means "today"
  poll: null,
  building: null,  // data for the checklist currently on screen
};

/* ------------------------------------------------------------------ utils */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function time(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(day) {
  if (!day) return '';
  if (day === state.config?.today) return 'Today';
  return new Date(`${day}T12:00:00`)
    .toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

function shiftDay(day, delta) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
  localStorage.removeItem('bc.token');
  localStorage.removeItem('bc.user');
  location.hash = '';
  render();
}

/* --------------------------------------------------------------- chrome */

function chrome({ title, back = false }) {
  bar.hidden = !state.user;
  $('#title').textContent = title;
  $('#back').hidden = !back;
  $('#signout').hidden = !state.user;
}

$('#back').onclick = () => (location.hash = '#/');
$('#signout').onclick = () => confirm('Sign out?') && signOut();

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
  return `<div class="row" style="gap:8px">
    <button class="ghost" data-day="${esc(shiftDay(day, -1))}">‹ Prev</button>
    <div class="grow center"><strong>${esc(dayLabel(day))}</strong>
      <div class="tiny muted">${esc(day)}</div></div>
    <button class="ghost" data-day="${esc(shiftDay(day, 1))}" ${isToday ? 'disabled' : ''}>Next ›</button>
  </div>`;
}

function wireDayNav(root, rerender) {
  root.querySelectorAll('[data-day]').forEach((b) => {
    b.onclick = () => {
      state.day = b.dataset.day === state.config.today ? null : b.dataset.day;
      rerender();
    };
  });
}

/* ------------------------------------------------------------ view: login */

function renderLogin() {
  bar.hidden = true;
  if (state.config.needsBootstrap) return renderBootstrap();

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
    </div>
  </div>`;

  let pin = '';
  const dots = $('#dots');
  const err = $('#err');
  const draw = () => (dots.textContent = '•'.repeat(pin.length));

  async function submit() {
    if (pin.length < 4) return;
    err.textContent = '';
    try {
      const { token, user } = await api('/login', { method: 'POST', body: { pin } });
      state.token = token;
      state.user = user;
      localStorage.setItem('bc.token', token);
      localStorage.setItem('bc.user', JSON.stringify(user));
      render();
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
  chrome({ title: 'Cleaning overview' });
  const day = viewDay();
  const { buildings } = await api(`/overview?day=${day}`);

  const totals = buildings.reduce((acc, b) => ({
    done: acc.done + b.done,
    total: acc.total + b.total,
    issues: acc.issues + b.open_issues,
    signed: acc.signed + (b.completed_at ? 1 : 0),
  }), { done: 0, total: 0, issues: 0, signed: 0 });

  const pct = totals.total ? Math.round((totals.done / totals.total) * 100) : 0;

  app.innerHTML = `
    <div class="card"><div class="pad">${dayNav(day)}</div></div>

    <div class="card">
      <div class="pad">
        <div class="spread">
          <div>
            <div style="font-size:30px;font-weight:700">${pct}%</div>
            <div class="small muted">${totals.done} of ${totals.total} tasks ·
              ${totals.signed}/${buildings.length} buildings signed off</div>
          </div>
          <div class="center">
            <div style="font-size:26px;font-weight:700;color:var(--${totals.issues ? 'warn' : 'muted'})">
              ${totals.issues}</div>
            <div class="tiny muted">open issues</div>
          </div>
        </div>
        <div class="meter ${pct === 100 ? 'full' : ''}"><i style="width:${pct}%"></i></div>
      </div>
    </div>

    <div class="card">
      <h2>Buildings</h2>
      ${buildings.map(buildingTile).join('')}
    </div>

    <div class="tabs">
      <button data-go="#/issues">Maintenance &amp; lost property</button>
      <button data-go="#/history">Activity log</button>
      ${state.user.role === 'admin' ? '<button data-go="#/admin">People</button>' : ''}
    </div>`;

  wireTiles();
  wireDayNav(app, renderOverview);
  poll(renderOverview, 30000);
}

/** True when this user is allowed to open an individual building's checklist. */
const canDrillIn = () =>
  state.user.role !== 'office' || !state.config.rollupOnly;

function buildingTile(b) {
  const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
  const status = b.completed_at
    ? `<span class="pill done">Signed off ${esc(time(b.completed_at))}</span>`
    : b.done
      ? '<span class="pill open">In progress</span>'
      : '<span class="pill idle">Not started</span>';

  const detail = [
    b.crew.length ? b.crew.map(esc).join(', ') : 'No one yet',
    b.last_at ? `last ${esc(time(b.last_at))}` : null,
    b.open_issues ? `${b.open_issues} open issue${b.open_issues > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' · ');

  return `<button class="tile" ${canDrillIn() ? `data-b="${b.id}"` : 'disabled'}>
    <div class="spread">
      <span class="name">${esc(b.name)}</span>
      ${status}
    </div>
    <div class="meter ${pct === 100 ? 'full' : ''}"><i style="width:${pct}%"></i></div>
    <div class="spread small muted" style="margin-top:6px">
      <span class="grow">${detail}</span>
      <span>${b.done}/${b.total}</span>
    </div>
  </button>`;
}

function wireTiles() {
  app.querySelectorAll('[data-b]').forEach((el) => {
    el.onclick = () => (location.hash = `#/b/${el.dataset.b}`);
  });
  app.querySelectorAll('[data-go]').forEach((el) => {
    el.onclick = () => (location.hash = el.dataset.go);
  });
}

/* ------------------------------------------------------ view: cleaner home */

async function renderCleanerHome() {
  chrome({ title: `Hi ${state.user.name}` });
  const { buildings } = await api(`/overview?day=${state.config.today}`);

  app.innerHTML = `
    <div class="card">
      <h2>Pick a building</h2>
      ${buildings.map(buildingTile).join('')}
    </div>
    <div class="tabs"><button data-go="#/issues">Reported issues</button></div>
    <p class="tiny muted center">
      Office ${esc(state.config.officePhone)} · Maintenance ${esc(state.config.maintenancePhone)}
    </p>`;

  wireTiles();
  poll(renderCleanerHome, 60000);
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
      if (!undo && done < total &&
          !confirm(`${total - done} item(s) still unticked. Mark complete anyway?`)) return;
      try {
        const res = await api('/building/complete', {
          method: 'POST', body: { buildingId: id, day, undo },
        });
        state.building.completed = res.completed;
        paintBuilding(state.building, locked);
        toast(undo ? 'Building reopened' : 'Marked complete — office can see it');
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
    $('#complete').textContent = data.completed ? 'Reopen building' : 'Mark building complete';
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
  chrome({ title: 'Report a problem', back: true });

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
      if (!file) return (photoBlob = null);
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
  chrome({ title: 'Maintenance & lost property', back: true });
  const { items } = await api(`/maintenance?status=${status}`);
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
          <div class="tiny muted">Reported by ${esc(i.reported_by)} on ${esc(i.day)}
            ${i.resolved_at ? ` · resolved by ${esc(i.resolved_by)}` : ''}</div>
          ${canResolve ? `<div style="margin-top:8px">
            <button class="ghost" data-r="${i.id}" data-reopen="${status === 'resolved'}">
              ${status === 'resolved' ? 'Reopen' : 'Mark resolved'}</button></div>` : ''}
        </div>`).join('')
        : `<p class="pad muted center">Nothing ${status === 'open' ? 'outstanding' : 'here'}.</p>`}
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
};

async function renderHistory() {
  chrome({ title: 'Activity log', back: true });
  const day = viewDay();
  const { activity } = await api(`/activity?day=${day}`);

  app.innerHTML = `
    <div class="card"><div class="pad">${dayNav(day)}</div></div>
    <div class="card">
      ${activity.length ? activity.map((a) => `
        <div class="list-item small">
          <div><strong>${esc(a.user_name)}</strong> ${esc(VERB[a.kind] || a.kind)}
            — ${esc(a.detail)}</div>
          <div class="tiny muted">${esc(a.building)} · ${esc(time(a.created_at))}</div>
        </div>`).join('')
        : '<p class="pad muted center">No activity on this day.</p>'}
    </div>
    <button class="wide" id="csv">Download CSV for this day</button>`;

  wireDayNav(app, renderHistory);
  $('#csv').onclick = async () => {
    try {
      const res = await request(`/report?from=${day}&to=${day}`);
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement('a'),
        { href: url, download: `cleaning-${day}.csv` }).click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/* ---------------------------------------------------------- view: admin */

async function renderAdmin() {
  chrome({ title: 'People', back: true });
  const { users } = await api('/users');

  app.innerHTML = `
    <div class="card">
      <h2>Add someone</h2>
      <div class="pad stack">
        <label class="field"><span>Name</span><input id="n"></label>
        <label class="field"><span>Role</span>
          <select id="r">
            <option value="cleaner">Cleaner — ticks checklists</option>
            <option value="office">Office — sees the overview, resolves issues</option>
            <option value="admin">Admin — everything, including people</option>
          </select></label>
        <label class="field"><span>PIN (4-8 digits)</span>
          <input id="p" inputmode="numeric" pattern="\\d*"></label>
        <p class="err" id="err"></p>
        <button class="primary wide" id="add">Add person</button>
      </div>
    </div>

    <div class="card">
      <h2>Everyone</h2>
      <table class="grid">
        <tr><th>Name</th><th>Role</th><th></th></tr>
        ${users.map((u) => `<tr style="${u.active ? '' : 'opacity:.5'}"
            data-id="${u.id}" data-name="${esc(u.name)}" data-role="${esc(u.role)}"
            data-active="${u.active}">
          <td>${esc(u.name)}</td>
          <td class="muted">${esc(u.role)}${u.active ? '' : ' · disabled'}</td>
          <td>
            <button class="ghost" data-pin>New PIN</button>
            <button class="ghost ${u.active ? 'danger' : ''}" data-tog>
              ${u.active ? 'Disable' : 'Enable'}</button>
          </td></tr>`).join('')}
      </table>
    </div>
    <p class="tiny muted center">PINs are stored hashed — they can be replaced, never read back.</p>`;

  $('#add').onclick = async () => {
    try {
      await api('/users', {
        method: 'POST',
        body: { name: $('#n').value, role: $('#r').value, pin: $('#p').value },
      });
      toast('Person added');
      renderAdmin();
    } catch (e) {
      $('#err').textContent = e.message;
    }
  };

  const rowOf = (btn) => btn.closest('tr').dataset;

  app.querySelectorAll('[data-pin]').forEach((b) => {
    b.onclick = async () => {
      const row = rowOf(b);
      const pin = prompt(`New PIN for ${row.name} (4-8 digits)`);
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
}

async function render() {
  stopPolling();

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
    if (head === 'issues') return await renderIssues();
    if (head === 'history') return await renderHistory();
    if (head === 'admin') return await renderAdmin();
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
