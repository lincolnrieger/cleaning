/**
 * Rebuilds docs/cleaner-manual.pdf and the screenshots it uses.
 *
 *   npm i playwright-core          (once, anywhere on the machine)
 *   node docs/tools/build-manual.mjs
 *   node docs/tools/build-manual.mjs --pdf-only    # skip the screenshots
 *
 * The screenshots are taken from the real front end running against the
 * stand-in API in mock-server.mjs, so they can never drift into showing a
 * screen the app does not have.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from './mock-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(HERE, '..');
const SHOTS = path.join(DOCS, 'manual');
const BASE = 'http://127.0.0.1:8787';

// Playwright's own download, or the browser this machine already has.
const EXECUTABLE = process.env.CHROMIUM_PATH || undefined;

const CLEANER = { id: 3, name: 'Casey Miller', role: 'cleaner' };

async function screenshots(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'en-AU',
    timezoneId: 'Australia/Adelaide',
  });
  const page = await ctx.newPage();
  const settle = (ms = 800) => page.waitForTimeout(ms);
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

  // Changing screen inside a single-page app keeps the scroll where it was,
  // so every screenshot would otherwise start half way down the last one.
  const go = async (hash) => {
    await page.goto(`${BASE}${hash}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle();
  };

  /** Blue numbered circles, anchored to real elements so they can't drift. */
  const annotate = (marks) => page.evaluate((list) => {
    document.querySelectorAll('.callout').forEach((n) => n.remove());
    const cardLeft = document.querySelector('main .card').getBoundingClientRect().left;
    for (const { sel, text, within, n } of list) {
      const scope = within
        ? [...document.querySelectorAll('.tile')].find((t) => t.textContent.includes(within))
        : document;
      if (!scope) continue;
      const el = text
        ? [...scope.querySelectorAll(sel)].find((e) => e.textContent.includes(text))
        : scope.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const badge = document.createElement('div');
      badge.className = 'callout';
      badge.textContent = n;
      Object.assign(badge.style, {
        position: 'absolute',
        left: `${cardLeft - 14}px`,
        top: `${r.top + scrollY + r.height / 2 - 14}px`,
        width: '28px',
        height: '28px',
        borderRadius: '50%',
        background: '#1d5fd0',
        color: '#fff',
        font: '700 16px/28px system-ui, sans-serif',
        textAlign: 'center',
        boxShadow: '0 0 0 3px #fff',
        zIndex: '60',
      });
      document.body.append(badge);
    }
  }, marks);

  /* Signing in: the names, then the pad. */
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await settle();
  await shot('sign-in-names');

  await page.click('button[data-uid="3"]');
  for (const key of ['8', '1', '4']) await page.click(`button[data-k="${key}"]`);
  await settle(400);
  await shot('sign-in-pin');

  /* Signed in as a cleaner from here on. */
  await page.evaluate((user) => {
    localStorage.setItem('bc.token', 'demo-token');
    localStorage.setItem('bc.tokenAt', String(Date.now()));
    localStorage.setItem('bc.user', JSON.stringify(user));
  }, CLEANER);

  await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await settle(1200);
  await shot('todays-list-plain');
  await annotate([
    { sel: '.periodnav', n: '1' },
    { sel: '.headline', n: '2' },
    { sel: '.banner.info', n: '3' },
    { sel: '.card h2', text: 'To clean today', n: '4' },
  ]);
  await settle(300);
  await shot('todays-list');

  await page.evaluate(() => window.scrollTo(0, 560));
  await settle(400);
  await annotate([
    { sel: '.pill.idle', within: 'Manor', n: '5' },
    { sel: '.tile-count', within: 'Manor', n: '6' },
    { sel: '.pill.done', within: 'Staff Toilet', n: '7' },
  ]);
  await settle(300);
  await shot('todays-list-more');

  // The badges live on <body>, which survives a change of screen, and the
  // scroll position survives with it. Both go before anything else is taken.
  await page.evaluate(() => {
    document.querySelectorAll('.callout').forEach((n) => n.remove());
    window.scrollTo(0, 0);
  });

  /* A building with no checklist: one button is the whole job. */
  await go('/#/b/2');
  await shot('building');

  /* The three tabs, on their own. Taken here, where the tab bar has empty
     page behind it: it is translucent, so anywhere else it captures a ghost
     of whatever it was sitting over. */
  await (await page.$('#nav')).screenshot({ path: path.join(SHOTS, 'tabs.png') });

  await page.click('#complete');
  await settle(600);
  await shot('confirm');
  await page.click('[data-cancel]');
  await settle(400);

  /* The same screen once it has been signed off. */
  await go('/#/b/3');
  await shot('signed-off');

  /* Reporting something. */
  await go('/#/b/2');
  await page.click('#report');
  await settle(400);
  await page.fill('#where', 'Room 3, upstairs');
  await page.fill('#detail', 'Tap in the basin drips constantly.');
  await settle(300);
  await shot('report');

  await go('/#/issues');
  await shot('reports-list');

  /* The week, as a cleaner sees it. */
  await go('/#/roster');
  await settle(600);
  await shot('roster');

  await ctx.close();
}

async function pdf(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`file://${path.join(DOCS, 'cleaner-manual.html')}`,
    { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: path.join(DOCS, 'cleaner-manual.pdf'),
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });
  await ctx.close();
}

const pdfOnly = process.argv.includes('--pdf-only');
const server = pdfOnly ? null : await startServer();
const browser = await chromium.launch({ executablePath: EXECUTABLE });

if (!pdfOnly) {
  await screenshots(browser);
  console.log(`screenshots → ${SHOTS}`);
}
await pdf(browser);
console.log(`manual → ${path.join(DOCS, 'cleaner-manual.pdf')}`);

await browser.close();
server?.close();
