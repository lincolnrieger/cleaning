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

## Step 1 — Create the site

> ### ⚠️ Use the Pages flow, not the Workers flow
>
> Cloudflare's dashboard pushes you towards **Workers** by default. The
> Workers setup screen has no *Build output directory* field, so if you're
> looking for it and can't find it, you're on the wrong screen.
>
> On the "Create a Worker" page there's a line near the repository list:
> **"Looking to deploy Pages? Get started"** — click that. Or go straight to
> `dash.cloudflare.com/<your-account-id>/workers-and-pages/create/pages`.
>
> This matters: the app's API lives in a `functions/` folder, which is a Pages
> convention. The Workers builder doesn't understand it, so the site would
> load but every checklist action would fail with a 404.

1. Go to <https://dash.cloudflare.com> and sign in.
2. In the left sidebar choose **Compute** → **Workers & Pages**.
3. Click **Create**. On the page that opens, find
   **"Looking to deploy Pages?"** and click its **Get started** link.
4. Choose **Connect to Git**, authorise Cloudflare to see your GitHub account,
   then pick the **`cleaning`** repository and click **Begin setup**.
5. Set the build settings exactly like this:

   | Field | Value |
   |---|---|
   | Project name | `cleaning` (this becomes your web address) |
   | Production branch | `claude/cleaning-checklist-tracker-62r7u3` |
   | Framework preset | **None** |
   | Build command | **leave completely empty** |
   | Build output directory | `public` |

   If you can't see the last two fields, expand **Build settings**. If they
   aren't there at all, you're on the Workers screen — see the warning above.

6. Click **Save and Deploy**.

It finishes in under a minute and shows you a URL like
`https://cleaning-xyz.pages.dev`. Opening it now will show an error about a
missing database — that's expected, you make it next.

> The empty build command is deliberate. Nothing needs compiling, which is a
> large part of why the site is fast and why deploys take seconds.

## Step 2 — Create the database

1. In the left sidebar choose **Storage & databases** → **D1 SQL Database**.
2. Click **Create Database**.
3. Name it `basecamp-cleaning` and click **Create**.

That's all. You do **not** need to create any tables or run any SQL — the app
does that itself the first time it runs.

## Step 3 — Connect the database to the site

1. Go back to **Workers & Pages** and click your **cleaning** project.
2. Open the **Settings** tab, then find **Bindings**.
3. Click **Add** → **D1 database** and fill in:
   - Variable name: **`DB`** (exactly this, capital letters)
   - D1 database: **basecamp-cleaning**
4. Save.

If you're offered a choice between **Production** and **Preview**, add it to
**Production**. Adding it to both is fine and means test deploys work too.

## Step 4 — Photos (needed for photos on checklist items)

This is what turns on **both** kinds of photo:

- a photo attached to a maintenance report, and
- **photos against individual checklist items** — the "📷 Photo required"
  feature, e.g. *Check that the fire extinguisher is present*.

Skip it and the app hides every camera button automatically — nothing breaks,
you just can't ask for photos.

1. Sidebar → **R2 Object Storage** → **Create bucket**, name it
   `basecamp-cleaning-photos`. Leave it **private** (the default). Do **not**
   enable public access: the app serves photos through its own API so they
   need a sign-in, and a public bucket would undo that.
2. Back in your Pages project → **Settings** → **Bindings** → **Add** →
   **R2 bucket**:
   - Variable name: **`PHOTOS`** (exactly this, capital letters)
   - Bucket: **basecamp-cleaning-photos**
3. Redeploy (step 5) — bindings only apply to deployments made after them.

R2 asks you to "add a payment method" to activate the service even on the free
plan. There is no charge on the free tier (10 GB of storage), but if you'd
rather not, skip this step — everything else works without it.

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

## Step 5 — Redeploy so the settings take effect

Bindings only apply to deployments made *after* you added them.

In your Pages project → **Deployments** tab → find the latest deployment →
click the **⋯** menu → **Retry deployment**.

## Step 6 — Create your admin account

Open your `.pages.dev` URL. Because there are no accounts yet, the app shows a
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

You can give it a proper address like `cleaning.yourcamp.org` under Pages
project → **Custom domains**, if you own a domain.

## If something goes wrong

| What you see | What it means | Fix |
|---|---|---|
| "No database is connected" | The `DB` binding is missing or was added after the last deploy | Check step 3, then redeploy (step 5) |
| Site loads but the checklist is empty | Deploy ran before the database was connected | Retry the deployment (step 5) |
| Photo buttons never appear | No R2 bucket bound, or bound after the last deploy | That's step 4 — then redeploy (step 5) |
| "Photo uploads are not set up on this site" | Same — the `PHOTOS` binding is missing | Step 4, then step 5 |
| A building's Check list is empty | It hasn't been set up yet | Step 7 — **Copy from the Full Clean** is the quick way |
| A cleaner got the wrong checklist | The job wasn't scheduled, so they chose | Schedule it with the right type; then it's automatic |
| Everyone's PIN suddenly fails | An `AUTH_SECRET` variable was added or changed in Settings | Remove it, redeploy, and PINs work again — or reset each PIN from the People screen |
| "Too many wrong PINs" | Someone mistyped 8+ times | Wait up to 5 minutes; it clears itself, and clears instantly on a correct PIN |

There's nothing you can break from the dashboard that a **Retry deployment**
won't fix. The one thing to leave alone is the `AUTH_SECRET` variable — the app
manages that itself, and overwriting it invalidates every PIN.
