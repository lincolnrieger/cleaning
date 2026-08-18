# Woodhouse Cleaning Tracker

A small, fast web app for tracking basecamp cleaning: cleaners tick off their
checklist on their phone, the office watches the whole camp on one screen and
builds the week's roster.

**To get it running, follow [SETUP.md](SETUP.md)** — it's all done in the
browser, no software to install and no commands to run.

---

## What each role sees

| | Cleaner | Office | Admin |
|---|---|---|---|
| Tick items off a checklist | ✅ | — | ✅ |
| Attach photos to checklist items | ✅ | — | ✅ |
| Sign a building off as complete | ✅ | — | ✅ |
| Report something that needs fixing | ✅ | ✅ | ✅ |
| Camp-wide progress overview | ✅ | ✅ | ✅ |
| See the week's building plan and staff roster | read-only | ✅ | ✅ |
| Plan which buildings get cleaned when, and in what order | — | ✅ | ✅ |
| Print the week's cleaning plan | — | ✅ | ✅ |
| Build and print the staff roster | — | ✅ | ✅ |
| See everyone's availability on one screen | — | ✅ | ✅ |
| Set anyone's availability (days **and** times) | — | ✅ | ✅ |
| Record preferred days and ideal hours | — | ✅ | ✅ |
| Open an individual building's detail | ✅ | read-only | ✅ |
| Mark a maintenance issue resolved | — | ✅ | ✅ |
| Activity log + CSV export | — | ✅ | ✅ |
| Add people, set PINs, delete accounts | — | — | ✅ |
| Edit buildings and their checklists | — | — | ✅ |

Everyone signs in with a 4–8 digit PIN. PINs are unique — the PIN *is* the
identity, which is what makes attribution work without usernames. The header
shows who is signed in, their role, and a colour-coded initials badge.

### Test mode

**People → Sign-in** has a switch that replaces the PIN pad with a list of
names — tap yourself and you're in. It makes setting up and demonstrating the
app much quicker.

It is also a wide open door: anyone with the link can sign in as anyone,
including an admin. While it's on, an orange banner sits across the top of
every screen so it can't be forgotten. **Turn it off before the cleaners start
using it for real** — one switch, and PINs are required again immediately.

---

## The two checklists: Full Clean and Check

Every building has **two** checklists, and each is edited separately:

- **Full Clean** — the whole thing, top to bottom.
- **Check** — the shorter walk-through: is it still clean, is it stocked, is
  anything broken.

Most buildings walk the same areas either way, so the two lists are the same
and each entry is stored once, **on both checklists** — edit it in one place
and it stays in step. Where a building genuinely has a shorter or different
check (the bell tents, the chalets, Seeonee), its Check list says so.

### What's on a checklist

**Broad areas, not individual jobs.** St George is *Bathrooms* and *Shelter*.
The Manor is *Stairwell and second floor*, *Toilets*, *Downstairs*,
*Corridors*, *Kitchen*, *Lower bathrooms*. What to do inside each one is on
the paper checklist the cleaners already carry; the app records that the area
was done, by whom, and when.

The *Every visit* block — litter, consumables, lost property, damage, secure —
is appended to every building, on both checklists.

### How a cleaner picks one — usually they don't

The point is that the choice is normally already made:

1. The office schedules **Hooper Bunkhouse → Check** for Tuesday.
2. Tuesday, the cleaner opens the app; the job tile says **Check**.
3. They tap it once and get the Check checklist. No menu, no decision.

For a building nobody has scheduled, tapping it asks **Full Clean or Check**
with two large buttons, and then goes straight in. Either way it's one or two
taps from the home screen to the correct list.

There's a segmented control at the top of every checklist to switch between
the two. If the office scheduled a Check and somebody is looking at the Full
Clean, an orange banner says so — switching is allowed, doing it by accident
isn't quiet.

Sign-offs are per checklist, so a building can be **checked** in the morning
and **fully cleaned** that afternoon, and the office sees both.

> One building can be scheduled once per day, for one of the two checklists.
> If a building genuinely needs both on the same day, schedule the Full Clean
> and let the cleaner switch — both sign-offs still record separately.

### Editing them

**Checklists** (admin only) opens on a **Full Clean / Check** tab pair. Under
it, every building, grouped the way the schedule grid groups them, each row
listing what's on its checklist, and a search box that matches building names
and checklist entries alike.

Tap a building and its whole checklist is on one page — a handful of rows, no
folding, nothing to drill into:

- **Add, edit, hide, delete and reorder** — ▲▼ on each row for a one-tap
  nudge, or **Reorder** for a drag-free list you rearrange and save once.
- **Which checklist it's on**: the Full Clean, the Check, or both.
- **Photo setting per entry**: no photo, photo allowed, or photo required.
- **Add the other list** — puts everything from the Full Clean onto the Check
  as well, ready to trim. It promotes each entry to *both* rather than
  copying it, so its history stays on one row and renaming it renames it
  everywhere. Anything already on the target is left alone.
- **Delete the building**, behind a type-the-name confirmation.

A banner warns you about any building whose Check list is still empty.

### Hiding versus deleting

**Hiding** is the everyday tool: it takes an entry off future checklists and
keeps every record of it having been cleaned. Adding the same name back
revives that same row, history and all, rather than starting a new one.

**Deleting is permanent.** Deleting an entry that has any history behind it
tells you exactly how many records go with it and makes you confirm; one
nobody has ever ticked deletes without ceremony. Deleting a building requires
typing its name.

### Reordering is safe against a second admin

When you save a new order, the app sends the whole list of ids and the server
checks it still matches what's there. If somebody else added or removed an
item while your screen was open, the reorder is refused with "this list
changed — reload and try again" rather than silently writing a stale order
over their work.

### The file versus the screen

**The first edit you make in the app takes over.** After that
`data/checklist.json` stops being applied on deploy, so a later push can't
quietly undo your work. The banner at the top of the page tells you which is
in charge. **Restore from file** hands it back — anything you added that isn't
in the file becomes hidden, and cleaning history is untouched either way.

So: use the file for bulk changes, use the screen for day-to-day tweaks, and
don't expect both at once.

---

## Photos on checklist items

Any item can be set to **allow** a photo or **require** one. An item that
requires one shows a **📷 Photo required** badge on the cleaner's phone.

- Tap **Add photo** and the phone offers camera or library.
- Several photos per item (up to six), each with a thumbnail.
- Tap the ✕ on a thumbnail to remove it — it's deleted from storage too.
- Photos are resized to 1280px in the browser before uploading, so it works on
  a weak mobile signal. The server refuses anything over 3 MB.
- Photos are private: they're served through the API and need a valid session.
  A direct link to the storage bucket won't work.

**Signing off checks the required ones.** If any item that requires a photo
hasn't got one, the sign-off stops and lists exactly which items. A cleaner
can still sign off anyway — a dead phone camera shouldn't strand a finished
building — but it's a deliberate second confirmation, and the activity log
records that it was signed off with photos missing.

Photos on **maintenance reports** work as before and are separate from this.

**This needs an R2 bucket bound as `PHOTOS`** — that's step 4 in
[SETUP.md](SETUP.md), and it takes about two minutes. Without it the app hides
the camera buttons automatically and nothing breaks; an item marked "photo
required" just says photo storage isn't set up.

---

## Reporting a problem

**Report a problem or leave a note**, from inside a building or from the blue
**+** button on any list screen.

- **Where** is a plain text box, not a dropdown — "Kitchen near main
  entrance", "Room 3, upstairs", whatever actually describes it. Optional.
- **Maintenance** reports stay open until the office resolves them. A
  **general note** — lost property, or anything else worth flagging that isn't
  a fault — doesn't count toward the "open issues" badge.
- One photo can be attached.

---

## Staff availability

**Planning → Availability** is every person's whole week on one screen — you
never have to open people one at a time.

| Staff | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| Casey | 8am–4pm | 8am–4pm | Unavailable | 9am–5pm | 8am–2pm |
| Dana | 10am–6pm | Unavailable | 8am–4pm | 8am–4pm | 10am–4pm |

Each cell also shows how many shifts that person already has that day, so you
can see who's carrying the week while you're reading who's free.

Filters across the top: **staff member**, **day**, **would rather work it**,
**available/unavailable**, and **free between** two times — set 13:00 to 17:00
and it dims everyone who can't cover that window.

Tap a name to set their availability: a switch per day plus a start and finish
time. Leave the times blank for a day they work with no set hours. Presets for
**copy the first day down** and **clear all** save some typing. Times use the
phone's native time picker.

Nobody's availability is ever assumed closed: a person whose record predates
this reads as available, not unavailable, so nobody silently drops off the
roster.

### Preferences — the soft stuff that makes rostering quicker

Availability answers *can they*. Two more fields on the same sheet answer
*would they*, which is what you're actually weighing up when you build a week:

- **Preferred days** — tap the star on any day they'd **rather** work. It
  never blocks anything and never raises a warning. What it does is sort:
  open a square on the roster and the people who want that day are at the top
  of the list, labelled *would rather work it*, with anyone unavailable at the
  bottom.
- **Ideal hours a week** — a target, e.g. 25. The availability grid and the
  roster then show **"22h of 25h"** against each person for the week you're
  looking at, and turn amber once they're over it. No adding shifts up by
  hand to see who's short and who's had too much. **Office and admin only** —
  a cleaner opening the roster sees the shifts and nobody's hours, and the
  figures aren't in the response their browser receives either.
Both are optional, and neither can stop you doing anything — they sort and
annotate. Availability is still the only thing that raises a conflict.

---

## The staff roster

**Planning → Staff roster** is the week: staff down the side, days across the
top. Tap any square to add a shift with a start time, finish time and an
optional note.

- The start and finish default to that person's availability for that day, so
  a normal shift is two taps.
- A person can have **more than one shift a day** — tapping a square that
  already has shifts lists them, with edit and delete on each.
- **Copy last week into this one** brings the whole previous week across,
  ready to adjust. It only works into an empty week, so it can't quietly
  duplicate anything.

### Availability conflicts are warned, never silent

Saving a shift that clashes stops and says exactly what's wrong:

- the person is marked **unavailable** that day
- the shift falls **outside** the hours they gave
- it **overlaps** another shift they already have

You can still roster it — swapping shifts is the normal case — but you say so
deliberately. Anything forced through **stays flagged**: the shift is marked
with ⚠ on the grid and a banner at the top counts them, so a clash created
three weeks ago is still visible now. Availability changing *after* the roster
was built re-flags it automatically.

### Printing it

**Print / save as PDF** on the roster prints just the roster — not the app.
It's a clean A4 landscape sheet:

**Cleaning Schedule - Week Commencing 10-08-2026**

| Staff | Mon | Tue | Wed | Thu | Fri | Sat | Sun |
|---|---|---|---|---|---|---|---|
| Casey | 8am–4pm | 8am–4pm | OFF | 10am–6pm | 8am–4pm | OFF | OFF |
| Dana | 10am–6pm | OFF | 8am–4pm | 8am–4pm | 10am–4pm | 9am–1pm | OFF |

Navigation, buttons, filters and the app header are all removed, days someone
isn't available read **OFF**, clashes carry a ⚠, and a staff member's row
never splits across pages.

**For a PDF**, use the same button and choose *Save as PDF* as the printer —
every browser and phone has it, and it produces the same layout. There's also
**Download CSV** if you'd rather have it in a spreadsheet.

---

## The cleaning plan

**Planning → Buildings** is a week grid: buildings down the side, days across
the top. Tap any square to put that building on the plan for that day, **pick
Full Clean or Check** (the sheet shows how many items each is), give it a
priority number, and add a note ("group arriving 2pm — finish by 1pm").

**The plan says what needs cleaning and in what order — not who does it.**
Who's in on a given day is the roster's job, and cleaners sort the buildings
out between themselves on the day. That's one less thing to keep in step, and
nobody is ever locked out of a building they weren't formally given.

Each square shows its priority, an **F** or **C** badge for which clean, the
office's note, and how it's going — green with a tick once it's signed off.
Today's column is highlighted and weekends are shaded back.

What that feeds:

- **Cleaners** open the app to **To clean today**, in priority order — the
  same list for everyone — each tile naming its checklist, the office's note,
  and who has already started it so two people don't double up. Everything
  unscheduled sits below. If they're rostered on, their shift times are at the
  top of the screen.
- **The office overview** becomes a run sheet: scheduled buildings first in
  priority order with "4 of 4 left" at the top and unscheduled buildings in a
  second column. The percentage and task counts cover **only what is scheduled
  for the day being viewed**, counted against the checklist that was planned.

### Printing the plan

**Print / save as PDF** under the grid prints the week's plan on its own — A4
landscape, the app furniture removed, each scheduled square showing its
priority number and the words *Full Clean* or *Check* rather than a colour, so
it still reads on a greyscale printer. Groups folded shut on screen are
printed anyway: a plan with buildings silently missing would be worse than no
plan. *Save as PDF* as the printer gives you a file instead.

**Removing a job from the plan** asks first, and if any work was already
recorded that day it offers to wipe those ticks, photos and the sign-off too —
**only for the checklist that was scheduled**, so clearing a Check can't erase
a Full Clean. Taking something off the plan and erasing what somebody actually
did are different intentions, so it never assumes.

Dates are shown Australian day-first throughout — `04-08-2026`, including in
the CSV exports.

---

## Clearing test data

**People → Danger zone** wipes every cleaning record, schedule, roster,
sign-off, photo and maintenance report, so you can start clean after
trialling it. You have to type `clear database` to arm the button, and there's
a second confirmation after that. Optionally it also removes everyone except
you.

It never drops a table, and it never touches your buildings or their
checklists. Photos are deleted from storage too.

Individual people can also be **deleted** outright from the People table, not
just disabled. Deleting removes them from the list and **from the roster** —
but **what they already cleaned stays in the records** under their name. You can't delete yourself, and you can't
delete the last admin. Disabling remains the softer option: it keeps the
account and just blocks sign-in.

## A note on "only the cleaners can see"

By default the office **can** open a building and see per-task detail, but
read-only — they can't tick anything. That is deliberate: you asked to see
*when each part was cleaned and who cleaned it*, and that detail only exists on
the individual checklist.

If you'd rather the office saw nothing but the rollup, add an environment
variable `OFFICE_ROLLUP_ONLY` set to `1` (Pages project → Settings →
Variables and Secrets) and redeploy. Building tiles stop being clickable for
office accounts, and the API refuses the request too — it's a real
restriction, not just a hidden button.

## Screens and devices

The interface is meant to read as a work tool, not an app: neutral surfaces,
one accent colour, and colour spent only where it means something — a state,
a warning, a clash. Everything else is typography, spacing and alignment.
There's one pattern per job (one kind of tab, one kind of segmented control,
one kind of button hierarchy) and no decoration that isn't carrying
information.

One layout serves both audiences deliberately. A cleaner holding a phone
one-handed in a wet bathroom gets 44px+ targets and one obvious next action;
the office on a laptop gets density and rows that scan, so people and
checklist items become tables rather than stacked cards.

A few things worth knowing:

- **The checklist keeps its controls in reach.** A progress line follows you
  down the list, and *Mark complete* sits in a bar pinned to the bottom of the
  screen rather than below the last entry.
- **Numbers line up.** Counts, times and dates use tabular figures, so a
  column of them can be read down.
- **Empty progress bars aren't drawn.** A building at 0/25 says "0/25"; it
  doesn't also get a grey bar that means nothing.
- Text inputs are 16px, the threshold below which iOS Safari zooms the page
  when you tap a field — so it never does. Buttons use
  `touch-action: manipulation` to drop the double-tap-to-zoom delay, and the
  layout respects the notch and home indicator via safe-area insets.
- Icons are one inline SVG set drawn on a single grid — no icon font, no CDN,
  no emoji, so nothing renders differently on somebody's phone.
- The bottom tab bar stays at six tabs at most, which is why the building
  schedule, the staff roster and availability share one **Planning** tab and
  sit behind a tab strip — they're three views of the same week.

Dark mode follows the phone's own setting, on every screen.

## How the tracking works

- **Everything is per day.** Each calendar day starts as a fresh checklist;
  yesterday's ticks stay in the record. Days are computed in the camp's
  timezone, not UTC, so a late-evening clean doesn't land on tomorrow. (Set a
  `TIMEZONE` variable to change it from `Australia/Sydney`.)
- **Every tick records who and when**, shown under the item and in the office's
  activity log. So does every photo added or removed.
- **Two cleaners can work the same room.** Each item is tracked independently,
  and each open checklist refreshes every 20 seconds, so they see each other's
  ticks appear with the other person's name against them.
- **Entries on both checklists are shared.** Ticking *Litter* during a Check
  also shows it ticked on that day's Full Clean — it was, after all, actually
  done. Entries that belong to only one checklist never cross over.
- **Sign-off is separate from ticking.** *Done — mark this complete* is the
  cleaner telling the office they've finished, per checklist. It confirms
  first, saying how many items are still unticked and whether any required
  photos are missing, then hands them back to their job list.

### Keeping the overview short

Both **Overview** and a cleaner's home screen only show what's actually
relevant by default: what's on the plan today. Everything else collapses
behind a single **"Not scheduled today · 21"** row rather than a long list of
tiles nobody needs to scan past.

### Maintenance alerts on your phone

**People → Maintenance alerts** turns on a free push notification the moment
a cleaner reports something that needs fixing — no need to keep the office
overview open to catch it.

It uses [ntfy.sh](https://ntfy.sh), a free, no-signup notification service.
Click **Generate a private topic**, **Save**, then install the free **ntfy**
app (App Store or Google Play) and subscribe to that exact topic name. The
topic name is the only thing keeping your alerts private, so don't post it
anywhere public — treat it like a password. **Send a test notification**
confirms it's wired up correctly before you rely on it.

If ntfy.sh is slow or unreachable, the report still saves normally — sending
the alert never blocks or fails a cleaner's report.

## Speed

There is no build step and no framework. The whole front end is three static
files served from Cloudflare's edge, and the API runs at the edge against
SQLite, which doesn't sleep between uses. Photos are resized in the browser
before upload. Nothing about the cleaning data is ever cached, so nobody acts
on stale information.

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
the connection drops for a moment.

## The checklist file

`data/checklist.json` holds all 21 buildings across the park, and both
checklists for each of them.

It has three parts:

- **`everyVisit`** — added to the bottom of *every* building's checklist, on
  **both** the Full Clean and the Check.
- **`buildings`** — each has a `group` (used as a label in the grid) and two
  flat lists, **`full`** and **`check`**. An area named in *both* lists is
  stored once and appears on both.
- **`contacts`** — the office and maintenance phone numbers on the cleaner's
  home screen.

Each entry is `["Name"]`, or `["Name", "A note"]`, with an optional third
value: `"photo"` to allow a photo against it, or `"photo required"` to insist
on one.

```json
{
  "name": "St George",
  "group": "Basecamp",
  "full": [["Bathrooms"], ["Shelter"]],
  "check": [["Bathrooms"], ["Shelter"]]
}
```

**These are areas, not jobs.** What to do inside *Bathrooms* belongs on the
paper checklist the cleaners carry — putting it here would give them forty
boxes to tick for one room, which is the thing this file deliberately doesn't
do.

Edit it on GitHub and commit — the site redeploys and updates itself, see the
end of [SETUP.md](SETUP.md). Removing something deactivates it rather than
deleting it, so past records never break.

*"Inform the office when cleaning is complete"* is deliberately not an entry:
**Mark complete** is that step, and having both would mean ticking a box and
then not pressing the button.

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

The first request after each deploy creates any missing tables, applies any
schema changes, and compares a hash of `checklist.json` against the last one it
stored. If they differ, it syncs buildings and their checklists — adding new
entries, updating wording, and deactivating anything removed. If they match it
does nothing. That's why there is no migration step to run and no SQL to paste.

**Foreign keys are enforced.** D1 has them on, and SQLite's `DROP TABLE`
runs an implicit delete that fires `ON DELETE CASCADE` on the way past — so
rebuilding a table that others point at will quietly take their rows with it,
with no error to notice. Where a migration has to rebuild `tasks`, the ticks
and photos are lifted into side tables with no constraints and put back
afterwards. The test harness runs with foreign keys on for the same reason:
with them off, that data loss is invisible.

**Upgrading an existing camp is safe.** When the checklist went from areas
containing individual jobs to one flat list, every existing item was carried
across onto its building with its row id intact, so no tick and no photo was
orphaned; the old fine-grained names keep their area as a prefix
("Kitchen - Bins") so a year of exported history still reads. Items that
predate cleaning types become "on both checklists" and existing sign-offs
become Full Clean sign-offs. Reports of the retired *Note* and *Lost property*
kinds became maintenance reports — relabelled, not deleted. Nothing is thrown
away.

## Security, honestly

This is sized for a small team, not a bank.

- PINs are hashed before storage, so a database dump doesn't hand over working
  PINs. Two people can't share a PIN — the app says so rather than failing.
- Sessions are signed tokens that expire after 14 hours — long enough for a
  shift, short enough that a shared phone doesn't stay signed in for a week.
- Deactivating someone in **People** cuts their access on their next request,
  not whenever their token happens to expire.
- The last active admin can't disable or demote themselves, so you can't lock
  yourself out of the People screen.
- Wrong-PIN attempts are throttled per IP: 8 free tries, then a lockout that
  tops out at 5 minutes and clears on the next correct PIN. It's deliberately
  forgiving because the whole camp shares one internet connection.
  **Use 6-digit PINs** to make up the difference.
- Photos — both on items and on reports — are served through the API and
  require a valid session. Keep the R2 bucket private (it is by default).
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
database storage and 10 GB of file storage. A resized checklist photo is
roughly 150–250 KB, so 10 GB is on the order of fifty thousand of them — a
camp taking twenty photos a day would take years to get near it.
