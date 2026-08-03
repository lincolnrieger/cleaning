# Basecamp Cleaning Tracker

A small, fast web app for tracking basecamp cleaning: cleaners tick off their
checklist on their phone, the office watches the whole camp on one screen.

**To get it running, follow [SETUP.md](SETUP.md)** — it's all done in the
browser, no software to install and no commands to run.

---

## What each role sees

| | Cleaner | Office | Admin |
|---|---|---|---|
| Tick items off a checklist | ✅ | — | ✅ |
| Sign a building off as complete | ✅ | — | ✅ |
| Report maintenance / lost property | ✅ | ✅ | ✅ |
| Camp-wide progress overview | ✅ | ✅ | ✅ |
| Open an individual building's detail | ✅ | read-only | ✅ |
| Mark a maintenance issue resolved | — | ✅ | ✅ |
| Activity log + CSV export | — | ✅ | ✅ |
| Add people, set PINs | — | — | ✅ |

Everyone signs in with a 4–8 digit PIN. PINs are unique — the PIN *is* the
identity, which is what makes attribution work without usernames.

### A note on "only the cleaners can see"

By default the office **can** open a building and see per-task detail, but
read-only — they can't tick anything. That is deliberate: you asked to see
*when each part was cleaned and who cleaned it*, and that detail only exists on
the individual checklist.

If you'd rather the office saw nothing but the rollup, add an environment
variable `OFFICE_ROLLUP_ONLY` set to `1` (Pages project → Settings →
Variables and Secrets) and redeploy. Building tiles stop being clickable for
office accounts, and the API refuses the request too — it's a real
restriction, not just a hidden button.

## How the tracking works

- **Everything is per day.** Each calendar day starts as a fresh checklist;
  yesterday's ticks stay in the record. Days are computed in the camp's
  timezone, not UTC, so a late-evening clean doesn't land on tomorrow. (Set a
  `TIMEZONE` variable to change it from `Australia/Sydney`.)
- **Every tick records who and when**, shown under the item and in the office's
  activity log.
- **Two cleaners can work the same room.** Each item is tracked independently,
  and each open checklist refreshes every 20 seconds, so they see each other's
  ticks appear with the other person's name against them.
- **Sign-off is separate from ticking.** "Mark building complete" is the
  cleaner telling the office they're done — it warns if items are still
  unticked, but doesn't force them. That replaces the "phone the office when
  finished" step on the paper checklist.
- **Maintenance and lost property** are reported from inside the building,
  optionally with a photo, and stay open until the office resolves them.

## Speed

There is no build step and no framework. The whole front end is three static
files served from Cloudflare's edge (~37 KB total, uncompressed), and the API
runs at the edge against SQLite, which doesn't sleep between uses. Photos are
resized to 1280px in the browser before upload, so reporting a problem works
on a weak mobile signal.

## Changing the checklist

Edit **`data/checklist.json`** on GitHub and commit. The site redeploys and
updates itself — see the end of [SETUP.md](SETUP.md).

`sharedAreas` applies to every building; a building can add its own areas on
top (Brownsea does). Removing something deactivates it rather than deleting
it, so past records never break.

## Project layout

```
data/checklist.json         the checklist content — edit this
functions/api/_setup.js     creates the tables and syncs the checklist
functions/api/[[path]].js   the rest of the API
public/                     index.html, app.js, styles.css
```

There's deliberately no `package.json` or `wrangler.toml`: the Cloudflare
dashboard owns the configuration, and adding those files back would let the
repo silently override what you set there.

### How the database sets itself up

The first request after each deploy creates any missing tables and compares a
hash of `checklist.json` against the last one it stored. If they differ, it
syncs buildings, areas and tasks — adding new ones, updating wording, and
deactivating anything removed. If they match it does nothing. That's why there
is no migration step to run and no SQL to paste.

## Security, honestly

This is sized for a small team, not a bank.

- PINs are hashed before storage, so a database dump doesn't hand over working
  PINs.
- Sessions are signed tokens that expire after 14 hours — long enough for a
  shift, short enough that a shared phone doesn't stay signed in for a week.
- Deactivating someone in **People** cuts their access on their next request,
  not whenever their token happens to expire.
- The last active admin can't disable or demote themselves, so you can't lock
  yourself out of the People screen.
- Wrong-PIN attempts are throttled per IP: 8 free tries, then a lockout that
  tops out at 5 minutes. It's deliberately forgiving because the whole camp
  shares one internet connection — a strict lockout would take everyone down
  when one person fumbles. **Use 6-digit PINs** to make up the difference.
- Photos are served through the API and require a valid session. Keep the R2
  bucket private (it is by default).

The signing key that protects sessions and PINs is generated by the app on
first run and stored in the database. That's what makes setup zero-config, and
the trade-off is worth naming: someone who obtains a full database dump has
both the key and the hashed PINs. If you'd rather separate them, set an
`AUTH_SECRET` variable (32+ random characters) in the dashboard **before you
create any accounts** — the app will use it instead. Adding or changing it
later invalidates every existing PIN.

What this does *not* do: no password recovery (an admin resets the PIN), no
audit trail on people changes, no encryption at rest beyond Cloudflare's own.

## Cost

Free, comfortably. Cloudflare's free tier covers 100k requests/day, 5 GB of
database storage and 10 GB of file storage. A five-building camp with a handful
of cleaners uses a rounding error of that.
