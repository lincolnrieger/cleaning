# The cleaner's manual

Two files, same guide. Sign in, read the day's list, mark a building done,
report a problem, and a cut-out card for the cupboard wall. Both document the
camp as it is set up now: **buildings with no checklist**, so a job is turn up,
clean it, press one button.

| | For |
|---|---|
| **[cleaner-manual.pdf](cleaner-manual.pdf)** | Printing and handing out. Twelve laid-out A4 pages. |
| **[cleaner-manual.docx](cleaner-manual.docx)** | Editing in Word. Same words and pictures, as an ordinary flowing document. |

**They are separate files.** Editing the Word version does not change the PDF —
export a new one from Word (*File → Save as → PDF*) when you want the printed
copy to match, or send the office's changes back here and rebuild both.

## Rebuilding them

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

The Word version is built from its own script, off the same screenshots:

```
npm i docx
node docs/tools/build-docx.mjs
```

Its wording lives in that script rather than in the HTML, so a change made for
print has to be made in both — which is the price of one of them being
editable by anyone with Word.

## What is what

```
cleaner-manual.pdf        the thing to print
cleaner-manual.html       its source — edit this, then rebuild
cleaner-manual.docx       the editable version, for Word
manual/                   the screenshots, all generated
tools/mock-server.mjs     serves public/ with fake data behind it
tools/build-manual.mjs    takes the screenshots, then prints the PDF
tools/build-docx.mjs      builds the Word version from the same pictures
```

The phone numbers on the cover and the back page come from `data/checklist.json`
by way of the mock server; the address of the site is deliberately a blank line
to write on, because it differs per camp.
