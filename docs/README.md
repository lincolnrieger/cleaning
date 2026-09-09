# The cleaner's manual

**[cleaner-manual.pdf](cleaner-manual.pdf)** — twelve A4 pages a cleaner can be
handed on their first morning. Sign in, read the day's list, mark a building
done, report a problem, and a cut-out card for the cupboard wall. The last
page is the whole thing in three steps.

It documents the camp as it is set up now: **buildings with no checklist**, so
a job is turn up, clean it, press one button.

## Rebuilding it

The screenshots are taken from the real front end in `public/`, driven by a
headless browser against a stand-in API. Nothing is drawn by hand, so a screen
that changes cannot quietly leave the manual showing something the app no
longer does.

```
npm i playwright-core          # once; the repo deliberately has no package.json
node docs/tools/build-manual.mjs
```

That rewrites every image in `docs/manual/` and then prints
`docs/cleaner-manual.html` to `docs/cleaner-manual.pdf`. To change the words
only, edit the HTML and skip the browser work:

```
node docs/tools/build-manual.mjs --pdf-only
```

If Chromium is somewhere Playwright doesn't look, point it there:
`CHROMIUM_PATH=/path/to/chrome node docs/tools/build-manual.mjs`.

## What is what

```
cleaner-manual.pdf        the thing to print
cleaner-manual.html       its source — edit this, then rebuild
manual/                   the screenshots, all generated
tools/mock-server.mjs     serves public/ with fake data behind it
tools/build-manual.mjs    takes the screenshots, then prints the PDF
```

The phone numbers on the cover and the back page come from `data/checklist.json`
by way of the mock server; the address of the site is deliberately a blank line
to write on, because it differs per camp.
