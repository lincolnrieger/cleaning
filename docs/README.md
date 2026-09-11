# The cleaner's guide

Four pages. Logging in, what to clean, marking a building done, reporting
something broken. That is the whole job, so that is the whole guide.

| | For |
|---|---|
| **[cleaner-manual.pdf](cleaner-manual.pdf)** | Printing and handing out. |
| **[cleaner-manual.docx](cleaner-manual.docx)** | Editing in Word. |

**The two files are built separately.** Editing the Word copy does not reprint
the PDF — export a new one from Word (*File → Save as → PDF*), or make the
change in `tools/content.mjs` and rebuild both.

## Changing the words

All the wording lives in **[tools/content.mjs](tools/content.mjs)** — page
titles, the numbered steps, the notes under them, the phone numbers. Both
builders read it, so a change there lands in both files and they cannot end up
saying different things.

## Rebuilding

The screenshots are taken from the real front end in `public/`, driven by a
headless browser against a stand-in API. Nothing is drawn by hand, so a screen
that changes cannot quietly leave the guide showing something the app no longer
does.

```
npm i playwright-core docx        # once; the repo deliberately has no package.json
node docs/tools/build-manual.mjs  # screenshots, then the PDF
node docs/tools/build-docx.mjs    # the Word version, from the same pictures
```

Add `--pdf-only` to the first one to skip the browser work when only the words
changed. If Chromium is somewhere Playwright doesn't look, point it there with
`CHROMIUM_PATH=/path/to/chrome`.

## What is what

```
cleaner-manual.pdf        the thing to print
cleaner-manual.docx       the editable copy, for Word
cleaner-manual.html       generated on the way to the PDF; not edited by hand
manual/                   the screenshots, all generated
tools/content.mjs         the words — edit these
tools/mock-server.mjs     serves public/ with fake data behind it
tools/build-manual.mjs    takes the screenshots, then prints the PDF
tools/build-docx.mjs      builds the Word version
```

The phone numbers come from `data/checklist.json` by way of the mock server.
The address of the site is a blank line to write on, because it differs per
camp.
