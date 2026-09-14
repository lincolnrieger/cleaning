/**
 * Rebuilds docs/cleaner-manual.pdf and the screenshots it uses.
 *
 *   npm i playwright-core          (once, anywhere on the machine)
 *   node docs/tools/build-manual.mjs
 *   node docs/tools/build-manual.mjs --pdf-only    # skip the screenshots
 *
 * The words come from content.mjs, shared with the Word version. The
 * screenshots are taken from the real front end running against the stand-in
 * API in mock-server.mjs, so they can never drift into showing a screen the
 * app does not have.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from './mock-server.mjs';
import { CONTACTS, COVER, PAGES, SUBTITLE, TITLE } from './content.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(HERE, '..');
const SHOTS = path.join(DOCS, 'manual');
const ICON = path.resolve(HERE, '../../public/icon-192.png');
const BASE = 'http://127.0.0.1:8787';

// Playwright's own download, or the browser this machine already has.
const EXECUTABLE = process.env.CHROMIUM_PATH || undefined;

const CLEANER = { id: 3, name: 'Casey Miller', role: 'cleaner' };

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'en-AU',
  timezoneId: 'Australia/Adelaide',
};

// The app words its "add me to your home screen" bar differently on an iPhone,
// where Safari has no one-tap install. Taking that shot through an iPhone user
// agent means the guide shows each phone the bar it will actually get.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/* ------------------------------------------------------------ screenshots */

async function screenshots(browser) {
  const ctx = await browser.newContext(PHONE);
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

  /* Logging in: the names, then the pad. */
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

  /* A building with no checklist: one button is the whole job. */
  await go('/#/b/2');
  await shot('building');

  await page.click('#complete');
  await settle(600);
  await shot('confirm');
  await page.click('[data-cancel]');
  await settle(400);

  /* Reporting something. */
  await go('/#/b/2');
  await page.click('#report');
  await settle(400);
  await page.fill('#where', 'Room 3, upstairs');
  await page.fill('#detail', 'Tap in the basin drips constantly.');
  await settle(300);
  await shot('report');

  /* The week, and the days a cleaner says they can work. */
  await go('/#/roster');
  await settle(600);
  await shot('roster');

  await go('/#/availability');
  await settle(600);
  // Far enough down that the day rows lead the picture, rather than the
  // tail of the paragraph above them.
  await page.evaluate(() => window.scrollTo(0, 385));
  await settle(400);
  await shot('availability');

  await ctx.close();

  fs.copyFileSync(ICON, path.join(SHOTS, 'icon.png'));

  /* The install bar, as each kind of phone sees it. */
  await installBar(browser, 'install-android');
  await installBar(browser, 'install-iphone', IPHONE_UA);
}

/** The sign-in screen, where the bar offering to add the app to the home
    screen sits. Its wording comes from the browser, so this runs once per
    kind of phone. */
async function installBar(browser, name, userAgent) {
  const ctx = await browser.newContext({ ...PHONE, ...(userAgent ? { userAgent } : {}) });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  await ctx.close();
}

/* ------------------------------------------------------------- the pages */

const esc = (s) => String(s).replace(/[&<>]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]
));

const imageBlock = (images) => `<div class="shots${images.length > 1 ? ' two' : ''}">
    ${images.map(([name, caption]) => `<figure>
      <img src="manual/${name}.png" alt="${esc(caption)}">
      <figcaption>${esc(caption)}</figcaption>
    </figure>`).join('')}
  </div>`;

const coverHTML = () => `<section class="page cover">
  <img class="icon" src="manual/icon.png" alt="">
  <p class="mark">${esc(COVER.kicker)}</p>
  <h1 class="big">${esc(TITLE)}</h1>
  <p class="sub">${esc(SUBTITLE)}</p>
  <p class="blurb">${esc(COVER.blurb)}</p>

  <p class="address">The app is at: <span class="write-in"></span></p>

  <p class="inside-head">${esc(COVER.inside)}</p>
  <ol class="inside">${PAGES.map((p) => `<li>${esc(p.title)}</li>`).join('')}</ol>

  <div class="contacts">${CONTACTS.map(([label, number]) =>
    `<p><span>${esc(label)}</span><b>${esc(number)}</b></p>`).join('')}</div>
</section>`;

const pageHTML = (page) => `<section class="page">
  <h1>${esc(page.title)}</h1>
  <ol>${page.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
  ${imageBlock(page.images)}
  ${page.note ? `<p class="note">${esc(page.note)}</p>` : ''}
  ${page.contacts ? `<div class="contacts">${CONTACTS.map(([label, number]) =>
    `<p><span>${esc(label)}</span><b>${esc(number)}</b></p>`).join('')}</div>` : ''}
</section>`;

const documentHTML = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(TITLE)} — ${esc(SUBTITLE)}</title>
<style>
/* Generated by docs/tools/build-manual.mjs — edit the words in content.mjs. */
@page { size: A4 portrait; margin: 0; }

body {
  margin: 0;
  font: 13pt/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  color: #16191f;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.page {
  position: relative;
  width: 210mm;
  height: 297mm;
  padding: 22mm 20mm;
  page-break-after: always;
  overflow: hidden;
}
.page:last-child { page-break-after: auto; }

.mark { margin: 0 0 4mm; font-size: 12pt; color: #6b7280; }
h1 { margin: 0 0 8mm; font-size: 30pt; line-height: 1.1; }

.address { margin: 0 0 6mm; font-size: 13pt; }
.write-in {
  display: inline-block;
  min-width: 80mm;
  border-bottom: 1px solid #9aa3b0;
}

ol { margin: 0 0 8mm; padding-left: 9mm; font-size: 15pt; }
ol li { margin-bottom: 4mm; padding-left: 2mm; }

.shots { display: flex; justify-content: center; gap: 12mm; }
.shots figure { margin: 0; text-align: center; }
.shots img {
  display: block;
  width: 76mm;
  border: 1px solid #dfe3e9;
  border-radius: 3mm;
}
.shots.two img { width: 65mm; }
figcaption { margin-top: 2mm; font-size: 11pt; color: #6b7280; }

.note {
  margin: 8mm 0 0;
  font-size: 13pt;
  color: #4a5261;
}

.cover .icon { width: 24mm; height: 24mm; display: block; margin-bottom: 10mm; }
.cover .mark { margin-bottom: 2mm; }
h1.big { font-size: 42pt; margin-bottom: 3mm; }
.cover .sub { margin: 0 0 8mm; font-size: 17pt; color: #4a5261; }
.cover .blurb { margin: 0 0 14mm; font-size: 15pt; max-width: 150mm; }
.cover .address { margin-bottom: 16mm; }
/* Pinned to the foot of the page: the numbers are what somebody reaches for
   when the guide is on a shelf, not something to read past. */
.cover .contacts { position: absolute; left: 20mm; bottom: 22mm; }
.inside-head { margin: 0 0 3mm; font-size: 12pt; color: #6b7280; }
ol.inside { margin: 0; font-size: 14pt; }
ol.inside li { margin-bottom: 3mm; }

.contacts { display: flex; gap: 10mm; margin-top: 8mm; }
.contacts p { margin: 0; font-size: 13pt; }
.contacts span { color: #6b7280; }
.contacts b { margin-left: 3mm; font-size: 16pt; }
</style>
</head>
<body>
${coverHTML()}
${PAGES.map(pageHTML).join('\n')}
</body>
</html>
`;

async function pdf(browser) {
  const html = path.join(DOCS, 'cleaner-manual.html');
  fs.writeFileSync(html, documentHTML());

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`file://${html}`, { waitUntil: 'networkidle' });
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
