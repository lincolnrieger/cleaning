# Setup — from zero to a live site

About 20 minutes, all free. You need a GitHub account and a Cloudflare account
(no credit card required for the free plan).

There are two halves: **make a database** (once, in a terminal) and **connect
the repo** (once, in the Cloudflare dashboard). After that, every `git push`
deploys automatically and you never touch the terminal again.

---

## Step 1 — Get the code onto your machine

```bash
git clone https://github.com/lincolnrieger/cleaning.git
cd cleaning
npm install
```

If you don't have Node.js, install it from <https://nodejs.org> first (the LTS
version). `npm install` only pulls in Cloudflare's deploy tool — the website
itself has no dependencies.

## Step 2 — Sign in to Cloudflare

```bash
npx wrangler login
```

A browser window opens. Approve it, come back to the terminal.

## Step 3 — Create the database

```bash
npx wrangler d1 create basecamp-cleaning
```

It prints a block like this:

```
[[d1_databases]]
binding = "DB"
database_name = "basecamp-cleaning"
database_id = "a1b2c3d4-...."
```

Copy that `database_id` and paste it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_DATABASE_ID`.

## Step 4 — Create the tables and load the checklist

```bash
npm run db:init
```

This runs `schema.sql` (the tables) and `seed.sql` (your five buildings and
their tasks) against the live database.

**Optional — photo uploads on maintenance reports:**

```bash
npx wrangler r2 bucket create basecamp-cleaning-photos
```

If you skip this, delete the `[[r2_buckets]]` block from `wrangler.toml`. The
app detects the missing bucket and hides the photo field — nothing breaks.

## Step 5 — Deploy it

```bash
npx wrangler pages deploy public
```

First run asks you to create the project — call it **basecamp-cleaning**. When
it finishes it prints your URL, something like
`https://basecamp-cleaning.pages.dev`.

## Step 6 — Set the sign-in secret

This is the key that signs login sessions. Generate a random one and store it:

```bash
npx wrangler pages secret put AUTH_SECRET --project-name basecamp-cleaning
```

It prompts for a value. Paste a long random string — generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Keep this value.** Changing it later signs everybody out **and invalidates
> every PIN**, because PINs are hashed with it. If you ever do change it, you
> have to reset every PIN from the People screen.

## Step 7 — Bind the database to the site

In the Cloudflare dashboard: **Workers & Pages → basecamp-cleaning → Settings
→ Bindings**.

- Add a **D1 database binding**: variable name `DB`, database
  `basecamp-cleaning`.
- If you made the photo bucket, add an **R2 bucket binding**: variable name
  `PHOTOS`, bucket `basecamp-cleaning-photos`.

Then **Deployments → ⋯ → Retry deployment** so the new bindings take effect.

## Step 8 — Connect GitHub so pushes deploy themselves

**Settings → Build → Connect to Git**, pick your `cleaning` repo, and set:

| Field | Value |
|---|---|
| Production branch | `main` |
| Build command | *(leave empty)* |
| Build output directory | `public` |

From now on, `git push` publishes in under a minute. There's no build step —
that's why it's fast.

## Step 9 — Create your admin account

Open your site. Because there are no accounts yet, it shows a one-time
**first-time setup** screen. Enter your name and choose a PIN. That screen
disappears permanently once the first account exists.

Then go to **People** and add everyone else. See `README.md` for what the
three roles can do.

---

## Changing the checklist later

Edit `data/checklist.json`, then:

```bash
npm run seed:build   # rewrites seed.sql
npm run db:seed      # applies it to the live database
git add -A && git commit -m "Update checklist" && git push
```

Re-seeding is safe to repeat. It adds new tasks, updates wording on existing
ones, and never touches the history of what was already cleaned.

## Running it on your own machine first

```bash
echo "AUTH_SECRET=any-long-local-string" > .dev.vars
npm run db:init:local
npm run dev
```

Then open <http://127.0.0.1:8788>. This uses a local copy of the database, so
you can experiment without touching the real one.

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| "Server is missing AUTH_SECRET" | Step 6 not done, or done before the project existed | Re-run step 6, then retry the deployment |
| "no such table: users" | Step 4 not run, or run against the local DB | `npm run db:init` (no `--local`) |
| Every page says "Please sign in" in a loop | `AUTH_SECRET` changed between deploys | Set it back, or reset all PINs |
| Photo field missing | R2 bucket not bound | Add the `PHOTOS` binding in step 7 |
| Everyone's PIN stopped working | `AUTH_SECRET` was changed | Sign in as admin and reset each PIN |
