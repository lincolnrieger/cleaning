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
| See the week's roster | read-only | ✅ | ✅ |
| Schedule buildings, assign cleaners, set priority | — | ✅ | ✅ |
| Open an individual building's detail | ✅ | read-only | ✅ |
| Mark a maintenance issue resolved | — | ✅ | ✅ |
| Activity log + CSV export | — | ✅ | ✅ |
| Set your own working days | ✅ | ✅ | ✅ |
| Set anyone's working days | — | ✅ | ✅ |
| Add people, set PINs, delete accounts | — | — | ✅ |
| Edit buildings, areas and checklist items | — | — | ✅ |

Everyone signs in with a 4–8 digit PIN. PINs are unique — the PIN *is* the
identity, which is what makes attribution work without usernames. The header
shows who is signed in, their role, and a colour-coded initials badge; that
same badge follows each person through the schedule grid and every tile, so
you can read who's on what at a glance.

### Test mode

**People → Sign-in** has a switch that replaces the PIN pad with a list of
names — tap yourself and you're in. It makes setting up and demonstrating the
app much quicker.

It is also a wide open door: anyone with the link can sign in as anyone,
including an admin. While it's on, an orange banner sits across the top of
every screen so it can't be forgotten. **Turn it off before the cleaners start
using it for real** — one switch, and PINs are required again immediately.

### Clearing test data

**People → Danger zone** wipes every cleaning record, schedule, sign-off and
maintenance report, so you can start clean after trialling it. You have to
type `clear database` to arm the button, and there's a second confirmation
after that. Optionally it also removes everyone except you.

It never drops a table, and it never touches your buildings, areas or tasks —
those come from `data/checklist.json`. Photos attached to cleared maintenance
reports are deleted from storage too.

Individual people can also be **deleted** outright from the People table, not
just disabled. Deleting removes them from the list and from any buildings
they're assigned to, but **what they already cleaned stays in the records**
under their name. You can't delete yourself, and you can't delete the last
admin. Disabling remains the softer option: it keeps the account and just
blocks sign-in.

### Availability

Each person has the days and hours they normally work — **People → Days** for
the office and admin, or **My days** in a cleaner's own nav. Tick a day on to
set a time range for it (a native time picker, so it's fast on a phone). It's
a general weekly pattern, not specific dates.

When you assign someone in the schedule, anyone who doesn't normally work that
weekday is listed last with a note saying so, and anyone who does shows their
hours ("available 08:00–14:00") — but **you can still pick anyone regardless**.
It's guidance for building the roster, never a block, because overriding it is
the normal case when someone swaps a shift.

### Editing checklists in the app

**Checklists** (admin only) lists every building, grouped the same way the
schedule grid groups them, with a search box that matches building names,
area names and individual items — type "kettle" and every building that has
one shows up. From there you can add a building, add or rename an area, and
add, reword or hide individual items.

**Hiding** is the everyday tool: it takes an item or area off future
checklists and keeps every record of it having been cleaned. Bringing it back
restores that history with it.

**Deleting an area is different and permanent.** It's on the area's own page,
separated out as a danger-zone action, and it requires typing the area's name
to confirm. Unlike hiding, it throws away every record of that area ever being
cleaned — there's no undo. Use it only for an area that should never have
existed; use hiding for everything else.

**The first edit you make here takes over.** After that `data/checklist.json`
stops being applied on deploy, so a later push can't quietly undo your work.
The banner at the top of the page tells you which is in charge. **Restore from
file** hands it back — anything you added that isn't in the file becomes
hidden, and cleaning history is untouched either way.

So: use the file for bulk changes, use the screen for day-to-day tweaks, and
don't expect both at once.

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

## Scheduling and assignment

**Schedule** is a week grid: buildings down the side, days across the top. Tap
any square to put that building on the roster for that day, choose who cleans
it, give it a priority number, and add a note ("group arriving 2pm — finish by
1pm"). Tap a scheduled square again to change or remove it.

Each square shows its priority, who's assigned, and how the clean is going —
green with a tick once it's signed off. Today's column is highlighted and
weekends are shaded back.

What that feeds:

- **Cleaners** open the app to **Your buildings today**, in priority order,
  with the office's note attached. Anything scheduled for someone else, and
  then everything unscheduled, appears below — a cleaner is never blocked from
  a building they weren't formally assigned.
- **The office overview** becomes a run sheet: scheduled buildings first in
  priority order with "4 of 4 left" at the top, unscheduled buildings in a
  second column, and a banner naming any scheduled building with nobody on it.
  The percentage and task counts across the top cover **only what is scheduled
  for the day being viewed** — totalling every task in the park would read
  "0 of 586" and say nothing useful about how the day is going.

More than one cleaner can be assigned to the same building — that's the case
the whole app is built around, so they're listed together and each still gets
their own attribution on the tasks they tick.

**Removing a job from the schedule** asks first, and if any work was already
recorded that day it offers to wipe those ticks and the sign-off too. Taking
something off the plan and erasing what somebody actually did are different
intentions, so it never assumes.

Dates are shown Australian day-first throughout — `04-08-2026`, including in
the CSV export.

## Screens and devices

One layout, built for both. On a phone it's a single column with 48px tap
targets; on a desktop the overview splits into two columns and the week grid
shows all seven days at once. The grid scrolls sideways on a narrow screen
with the building names pinned in place.

Text inputs are set to 16px, which is the threshold below which iOS Safari
zooms the page when you tap a field — so it never does that. Buttons use
`touch-action: manipulation` to drop the double-tap-to-zoom delay, and the
layout respects the notch and home indicator via safe-area insets.

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
- **Sign-off is separate from ticking.** *Done — mark this building complete*
  is the cleaner telling the office they've finished. It confirms first,
  saying how many items are still unticked, then hands them back to their job
  list so they can pick up the next building. That replaces the "phone the
  office when finished" step on the paper checklist.
- **Maintenance and lost property** are reported from inside the building,
  optionally with a photo, and stay open until the office resolves them.

## Speed

There is no build step and no framework. The whole front end is three static
files served from Cloudflare's edge (~60 KB total, uncompressed), and the API
runs at the edge against SQLite, which doesn't sleep between uses. Photos are
resized to 1280px in the browser before upload, so reporting a problem works
on a weak mobile signal.

## Installing it as a phone app

It's a Progressive Web App — no App Store, nothing to publish, just the same
website installed so it behaves like one.

- **Android (Chrome/Edge):** open the site; a banner under the sign-in screen
  offers **Install**. Tapping it adds a real home-screen icon that opens full
  screen, no address bar. If the banner doesn't appear, the browser's own menu
  has **Add to Home screen** / **Install app**.
- **iPhone / iPad (Safari):** Safari doesn't support one-tap install, so the
  banner instead says tap **Share → Add to Home Screen**. That's the whole
  process — same result, one extra tap.

Once installed, opening the icon behaves like a native app: its own launcher
icon, a coloured status bar, and no browser chrome. A small service worker
caches the app's shell (the HTML/CSS/JS, not the data) so it still opens if
the connection drops for a moment — but every checklist, schedule and report
is always fetched live. Nothing about the cleaning data is ever cached, so
nobody acts on stale information.

## The checklist

`data/checklist.json` holds all 21 buildings across the park — the five
Basecamp locations, five Bell Tents, Bunkhouse, three Chalets, Lower Rymill,
Manor, both Offices, Rymill Centre, Seeonee and Stags — just under 600 tasks
in total.

It has three parts:

- **`everyVisit`** — added to the bottom of *every* building's checklist
  (litter, consumables, lost property, damage, leaving it secure).
- **`templates`** — reusable areas. `Bathrooms` and `Shelter` are shared by the
  five Basecamp locations; `Accommodation`, `Toilet and shower`, `Outdoor` and
  `Chalet check clean` by the three chalets. Edit one, and every building using
  it changes.
- **`buildings`** — each has a `group` (used as a label in the grid) and a list
  of areas. An entry that's just a name refers to a template; anything else is
  written inline for that building alone.

Edit it on GitHub and commit — the site redeploys and updates itself, see the
end of [SETUP.md](SETUP.md). Removing something deactivates it rather than
deleting it, so past records never break.

*"Inform the office when cleaning is complete"* is deliberately not a task:
**Mark building complete** is that step, and having both would mean ticking a
box and then not pressing the button.

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
- Test mode (tap-to-sign-in) bypasses all of the above by design. It ships
  switched **on** so there's nothing to configure on day one; switch it off in
  **People** the moment real rosters go in.

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
