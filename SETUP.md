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

## Step 4 — Photos on maintenance reports (optional)

Skip this if you don't want cleaners attaching photos. The app hides the photo
field automatically when it's not set up — nothing breaks.

1. Sidebar → **R2 Object Storage** → **Create bucket**, name it
   `basecamp-cleaning-photos`. Leave it **private** (the default).
2. Back in your Pages project → **Settings** → **Bindings** → **Add** →
   **R2 bucket**:
   - Variable name: **`PHOTOS`**
   - Bucket: **basecamp-cleaning-photos**

R2 asks you to "add a payment method" to activate the service even on the free
plan. If you'd rather not, skip this step — everything else works without it.

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
their own PIN; that PIN is how the app knows who cleaned what.

**Use 6-digit PINs.** Four digits is guessable, and everyone at camp shares one
internet connection, so the app can't lock out attackers as aggressively as it
otherwise would.

---

## Changing the checklist later — also in the browser

1. On GitHub open **`data/checklist.json`**.
2. Click the **pencil icon** to edit it.
3. Make your change. Every task is a pair: `["Item", "What to do"]`.
4. Click **Commit changes**.

Cloudflare redeploys within a minute and the app updates itself. You can add
tasks, reword them, add or remove buildings — all from that one file.

**Removing a task doesn't delete history.** It stops appearing on checklists,
but the record of every time it was cleaned stays in the activity log and CSV
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
| Photo field never appears | No R2 bucket bound | That's step 4, and it's optional |
| Everyone's PIN suddenly fails | An `AUTH_SECRET` variable was added or changed in Settings | Remove it, redeploy, and PINs work again — or reset each PIN from the People screen |
| "Too many wrong PINs" | Someone mistyped 8+ times | Wait up to 5 minutes; it clears itself, and clears instantly on a correct PIN |

There's nothing you can break from the dashboard that a **Retry deployment**
won't fix. The one thing to leave alone is the `AUTH_SECRET` variable — the app
manages that itself, and overwriting it invalidates every PIN.
