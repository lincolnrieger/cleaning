# Setup — entirely in your browser

No downloads, no terminal, no commands. Two browser tabs (GitHub and
Cloudflare) and about 15 minutes.

You need a free Cloudflare account: <https://dash.cloudflare.com/sign-up>.
No credit card.

> **Why Cloudflare and not Vercel?** Vercel's free databases go to sleep after
> a few minutes of no use, so the first cleaner to open the app after a quiet
> hour would wait several seconds for it to wake up. Cloudflare's database
> doesn't sleep and its code runs with no cold start. Same click-through
> dashboard, genuinely faster for how you'll use it.

---

## Step 1 — Create the database

1. Go to <https://dash.cloudflare.com> and sign in.
2. In the left sidebar choose **Storage & databases** → **D1 SQL Database**.
3. Click **Create Database**, name it `basecamp-cleaning` and click **Create**.
4. Copy its **Database ID** (it looks like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
5. On GitHub, open **`wrangler.jsonc`**, click the pencil icon, replace
   `REPLACE_WITH_DATABASE_ID` with that ID, and **Commit changes**.

You do **not** need to create any tables or run any SQL — the app does that
itself the first time it runs.

## Step 2 — Photos (needed for photos on checklist items)

This is what turns on **both** kinds of photo:

- a photo attached to a maintenance report, and
- **photos against individual checklist items** — the "📷 Photo required"
  feature, e.g. *Check that the fire extinguisher is present*.

1. Sidebar → **R2 Object Storage** → **Create bucket**, name it
   `basecamp-cleaning-photos`. Leave it **private** (the default). Do **not**
   enable public access: the app serves photos through its own API so they
   need a sign-in, and a public bucket would undo that.

That's it — `wrangler.jsonc` already connects a bucket of that name as
`PHOTOS`.

R2 asks you to "add a payment method" to activate the service even on the free
plan. There is no charge on the free tier (10 GB of storage). If you'd rather
skip photos, delete the whole `"r2_buckets"` block from `wrangler.jsonc`
instead — otherwise the deploy fails looking for a bucket that isn't there.
Without it the app hides every camera button automatically; nothing else
breaks.

**Nothing else to configure.** No table to create, no size limits to set, no
folder structure to make. The app resizes photos to 1280px in the browser
before uploading, refuses anything over 3 MB, and allows up to six photos per
checklist item per day.

### Then, in the app

Go to **Checklists**, pick the **Full Clean** or **Check** tab, open a
building, then add an entry or tap **Edit** on one. The **Photo** setting has
three options:

| Setting | What the cleaner sees |
|---|---|
| No photo | An ordinary tick box |
| Photo allowed | An **Add photo** button they can ignore |
| Photo required | A **📷 Photo required** badge, and sign-off warns if it's missing |

**Photo required is a warning, not a lock.** A cleaner can still sign off a
building with a photo missing — a flat phone battery shouldn't strand a
finished building — but it takes a second, deliberate confirmation and the
record shows that it was signed off short.

### Housekeeping

Photos are deleted from storage automatically when the photo itself is
removed, when a scheduled job's progress is wiped, when the checklist entry or
the building is deleted, and when you clear the database from **People →
Danger zone**. There is no orphan cleanup job because nothing is left orphaned.

## Step 3 — Create the site

1. Sidebar → **Compute** → **Workers & Pages** → **Create**.
2. Choose **Import a repository** (Workers), authorise Cloudflare to see your
   GitHub account if asked, pick the **`cleaning`** repository and continue.
3. Settings:

   | Field | Value |
   |---|---|
   | Project name | `cleaning-tracker` — **must match** `"name"` in `wrangler.jsonc` |
   | Build command | **leave empty** |
   | Deploy command | `npx wrangler deploy` (the default) |

4. Under **Advanced settings** (or afterwards in **Settings → Build**), set
   the production **branch** to `claude/cleaning-checklist-tracker-62r7u3`.
5. Click **Deploy**.

It finishes in about a minute and gives you a URL like
`https://cleaning-tracker.<your-name>.workers.dev`.

> Everything the site is connected to — the database and the photo bucket —
> comes from `wrangler.jsonc`, so there is no Bindings screen to fill in. Plain
> settings like `TIMEZONE` still go under **Settings → Variables and Secrets**,
> and a deploy leaves them alone.

## Step 4 — Your own address (optional)

Open **cleaning-tracker** → **Settings** → **Domains & Routes** → **Add** →
**Custom domain**, and enter something like `cleaning.yourcamp.org`. The
domain has to be on the same Cloudflare account. Cloudflare creates the DNS
record and the certificate itself; the certificate can take a few minutes.

## Step 5 — Redeploy after changing settings

Variables only apply to deployments made *after* you add them. Either push
any commit, or open **cleaning-tracker** → **Deployments** and deploy the
latest version again.

## Step 6 — Create your admin account

Open your site's URL. Because there are no accounts yet, the app shows a
one-time **first-time setup** screen. Enter your name and choose a PIN.

That screen disappears permanently the moment the first account exists — nobody
else can use it to make themselves an admin.

Then tap **People** and add your cleaners and office staff. Each person gets
their own PIN; tapping your name and entering it is how the app knows who
cleaned what.

**Use 6-digit PINs.** Four digits is guessable, and everyone at camp shares one
internet connection, so the app can't lock out attackers as aggressively as it
otherwise would.

Everyone signs in once on their own phone and stays signed in — the session
lasts 90 days and renews itself with use — so the PIN is a one-off, not a
daily ritual. If a phone goes missing, switch that person off under **People**;
their access stops on the next request.

---

## Step 7 — Build your buildings and their checklists

The app ships with one building called **Test** and nothing else, so this step
is where the park gets entered.

A checklist here is the **broad areas** of a building, not the individual jobs
inside them — a block is *Bathroom* and *Kitchen*, a lodge is its five rooms.
What an area covers (toilets, surfaces, refilling dispensers) is the note
printed under it, so it reads as one tick rather than five; the app records
that the area was done, by whom, and when.

Every building has a **Full Clean** and a **Check**. Both usually walk the
same areas, so an entry can be marked **on both checklists** and maintained
once — the Check is the same round, done faster.

1. **Checklists** → **Add a building**. Give it a name, and a group if several
   share one (chalets, bell tents) so they fold together on every screen.
2. Open it and add its areas, with a note under each saying what it covers.
   Set anything that belongs on both lists to **Both**.
3. A banner names any building whose Check list is still empty. Open it and
   either add entries by hand, or tap **Add the Full Clean list** and trim.
4. Delete the **Test** building once you no longer need it.

The first edit here takes ownership of the checklists, and
`data/checklist.json` stops being applied on deploy — so nothing you build on
this screen can be undone by a later push.

Then **Planning → Buildings**: tap a square, pick **Full Clean** or **Check**,
tick **Checking in today** if guests arrive there that day, set the order it
gets done in if it matters, and the cleaner gets exactly that list when
they open the job. The plan doesn't name who cleans what — that's the roster's
job, and the cleaners sort the buildings out between themselves on the day.
**Print / save as PDF** under the grid prints the week's plan on one A4 sheet.

## Step 8 — Availability and the roster

1. **Planning → Availability** — tap each name and set the days they work and
   the hours.

   On the same sheet you can also record the softer things that make the
   roster quicker to build: tap the **star** on days they'd *rather* work, and
   set their **ideal hours a week**. Neither blocks anything — it puts the
   right people at the top of the list when you're picking someone, and shows
   hours rostered against the target.
2. **Planning → Staff roster** — tap a square to add a shift. The times default
   to that person's availability, so a normal shift is two taps.
3. **Print / save as PDF** when the week is set. Choose *Save as PDF* as the
   printer for a PDF; it's the same layout either way, A4 landscape.

Rostering somebody outside their availability warns you first and stays
flagged afterwards, so a clash can't quietly survive to Monday morning.

---

## Changing the checklist later — also in the browser

Two ways, and only one is in charge at a time:

**In the app** (**Checklists**) — day-to-day edits. **The first edit you make
here takes over**, and `data/checklist.json` stops being applied on deploy, so
a later push can't undo your work. This is the normal way to work.

**In the file** — good for bulk changes before you've started editing in the
app:

1. On GitHub open **`data/checklist.json`**.
2. Click the **pencil icon** to edit it.
3. Make your change. Every task is `["Item", "What to do"]`, with an optional
   third value: `"photo"` or `"photo required"`. Each building has a `full`
   list and a `check` list.
4. Click **Commit changes**.

Cloudflare redeploys within a minute and the app updates itself.

To go back to the file after editing in the app, use **Restore from file** at
the bottom of the Checklists screen — it asks you to type "restore".

**Removing a task doesn't delete history.** It stops appearing on checklists,
but the record of every time it was cleaned stays in the CSV
exports. Put it back and it returns with its history intact.

## Sharing it with your team

Everyone uses the same URL. Tell them to open it on their phone and use
**Add to Home Screen** (iPhone: Share → Add to Home Screen; Android: menu →
Add to home screen). It then opens like an app, full screen, with no browser
bar.

You can give it a proper address like `cleaning.yourcamp.org` — see step 4.

## If something goes wrong

| What you see | What it means | Fix |
|---|---|---|
| The deploy fails mentioning the database | `database_id` in `wrangler.jsonc` is still the placeholder or wrong | Step 1, point 5 |
| The deploy fails mentioning an R2 bucket | The bucket doesn't exist, or R2 isn't activated | Create it (step 2) or delete the `"r2_buckets"` block |
| The deploy fails mentioning the name | Project name and `"name"` in `wrangler.jsonc` differ | Make them match (step 3) |
| "No database is connected" | The `DB` block is missing from `wrangler.jsonc` | Step 1, then redeploy (step 5) |
| Photo buttons never appear | No `"r2_buckets"` block in `wrangler.jsonc` | Step 2, then redeploy (step 5) |
| A building's Check list is empty | It hasn't been set up yet | Step 7 — **Copy from the Full Clean** is the quick way |
| A cleaner got the wrong checklist | The job wasn't scheduled, so they chose | Schedule it with the right type; then it's automatic |
| Everyone's PIN suddenly fails | An `AUTH_SECRET` variable was added or changed in Settings | Remove it, redeploy, and PINs work again — or reset each PIN from the People screen |
| "Too many wrong PINs" | Someone mistyped 8+ times | Wait up to 5 minutes; it clears itself, and clears instantly on a correct PIN |

There's nothing you can break from the dashboard that a **redeploy**
won't fix. The one thing to leave alone is the `AUTH_SECRET` variable — the app
manages that itself, and overwriting it invalidates every PIN.

---

## Moving an existing site from Pages to Workers

The app used to run as a Cloudflare **Pages** project. If yours still does,
this moves it across with **no data lost** — the Worker uses the same
database, so every account, PIN, checklist and photo carries over.

1. **Point the config at your existing database and bucket.** In
   `wrangler.jsonc`, set `database_id` to the ID of the database the Pages
   project uses (Pages project → Settings → Bindings shows its name; D1 shows
   the ID). Check `bucket_name` matches your photo bucket, or delete the
   `"r2_buckets"` block if you never set photos up.
2. **Copy any variables.** Pages project → Settings → Variables and Secrets.
   Add the same ones to the Worker after step 3. If there's an `AUTH_SECRET`
   there, copying it is essential — without it every PIN stops working. (If
   there isn't one, there's nothing to do: the app keeps its own key in the
   database.)
3. **Create the Worker** — step 3 above. Open its `workers.dev` URL and sign
   in to check it shows your real data.
4. **Move the address.** Pages project → **Custom domains** → remove your
   domain. Then delete its leftover CNAME record under **DNS → Records** if
   one remains. Then add the domain to the Worker (step 4). The address is
   down for a minute or two in between.
5. **Retire the Pages project** once you're happy: Pages project → Settings →
   **Delete project**. Until then, keep it around as a fallback; both read and
   write the same database, so it's safe either way.

Installed home-screen apps keep working: they open the same address, and the
service worker picks up the new site on its next load.
