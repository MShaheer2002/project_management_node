# Step 5 — DigitalOcean App Platform (the actual backend)

Fifth thing to do, after the database (`steup-1-db-neon.md`), Redis
(`steup-2-redis-upstash.md`), the Dockerfile (`setup-3-dockerfile.md`), and
applying migrations to production (`step-4-migration-neon.md`). This is
where the backend actually goes live for the first time. Nothing before
this point was reachable from the internet — Neon and Upstash are just
data stores sitting there, and the Dockerfile was only ever built and run
locally.

The frontend (Vercel) comes *after* this, not before — it needs a live
backend URL to point at.

---

## Prerequisites (already done, listed so you can confirm before starting)

- `Dockerfile` / `.dockerignore` / `prisma.config.ts` committed and pushed
  to GitHub — currently on branch `feat/ai-agent-redesign`, not `main`.
- Production Neon database has all 59 migrations applied (confirmed:
  `Database schema is up to date!`, 57 tables).
- `.env.production` fully populated (68 keys, no quotes — Docker's
  `--env-file` doesn't strip them, see `setup-3-dockerfile.md` §5).
- A DigitalOcean account, and a GitHub account with access to the
  `project_management_node` repo.

**One decision to make at step 2 below, not before:** DO will ask which
branch to deploy from. Since this repo's deployment work only exists on
`feat/ai-agent-redesign`, point it there directly rather than merging to
`main` first just to unblock deployment — merge into `main` whenever that
branch is actually ready on its own timeline, then repoint DO at `main` at
that point (a one-line change in DO's settings, not a redo of this guide).

---

## 1. Create the app

1. DigitalOcean dashboard → **Apps** → **Create App**.
2. Choose **GitHub** as the source, authorize DO's GitHub App if this is
   the first time (it'll ask which repos to grant access to — select
   `project_management_node` specifically, not "all repositories," unless
   you're fine granting more).
3. Pick the repo, then the branch: **`feat/ai-agent-redesign`** (see the
   decision note above).
4. DO scans the repo and should detect a `Dockerfile` at the root and
   offer **"Dockerfile"** as the build method — pick that explicitly if
   it defaults to buildpacks instead. Buildpacks would try to guess how to
   build a Node app from scratch and ignore the Dockerfile entirely, which
   is not what you want here.

---

## 2. Configure the first component — `api`

DO creates one component from what it detected. Configure it as:

| Setting | Value |
|---|---|
| Name | `api` |
| Type | Web Service |
| HTTP Port | `8000` |
| Health check path | `/health` |
| Run command | leave default — the Dockerfile's `CMD` (`node dist/app/server.js`) |
| Instance size | **Basic, 1 vCPU / 512 MiB — $5/mo** to start (see cost note below) |
| Instance count | 1 |

Don't set the Pre-Deploy Job yet — that's step 5 below, added only after
this first deploy actually succeeds. Trying to run migrations against a
component that hasn't proven it can build and boot yet just makes the
first failure harder to diagnose.

---

## 3. Add the second component — `ai-worker`

**Add Component** → same GitHub source/branch → same Dockerfile. This
reuses the identical image; only the run command differs.

| Setting | Value |
|---|---|
| Name | `ai-worker` |
| Type | **Worker** (no public HTTP port — don't pick Web Service here) |
| Run command override | `node dist/workers/ai-background.worker.js` |
| Instance size | Basic, 1 vCPU / 512 MiB — $5/mo |
| Instance count | 1 |

Worker components don't get a public URL and don't need an HTTP port
configured — DO still tracks health via `AI_WORKER_HEALTH_PORT` (already
`9201` in your env vars) internally, but nothing external hits it.

**Cost so far: $10/month** (two $5 components). No free tier applies to
either — that only exists for DO's static-site hosting, not services or
workers. See the earlier cost breakdown in this conversation if you want
the full tier table; $5/mo each is the right starting point; resize later
in DO's dashboard (no redeploy-from-scratch needed) if 512 MiB turns out
to be tight once the AI worker is actually processing embeddings.

---

## 4. Environment variables — both components

DO's env var editor has a **Bulk Editor** button that accepts pasted
`KEY=value` lines directly — this is the fast path here since
`.env.production` already has all 68 keys filled in correctly (unquoted,
already fixed per `setup-3-dockerfile.md` §5).

1. Open `.env.production` locally.
2. On the `api` component's Environment Variables section, click **Bulk
   Editor**, paste the whole file's contents in, save.
3. Repeat the exact same paste on the `ai-worker` component — both need
   the same full set, since it's the same image and the same `config/env.ts`
   validation runs in both processes.
4. Mark the sensitive ones **Encrypted** (DO does this automatically for
   values it recognizes as secrets after a bulk paste, but double-check
   `CLERK_SECRET_KEY`, `STRIPE_SECRET_KEY`, `DATABASE_URL`, `DIRECT_URL`,
   `AWS_SECRET_ACCESS_KEY`, `REDIS_URL`, `RESEND_API_KEY`,
   `ENCRYPTION_KEY`, and the webhook secrets specifically — anything DO
   left as plain-text "General" that shouldn't be).

One thing worth knowing so it doesn't look broken later: `config/env.ts`
(the schema the running app validates against) never actually reads
`DIRECT_URL` — only `prisma.config.ts` does, and only when the Prisma CLI
runs. Setting `DIRECT_URL` on both components now is harmless and saves a
step later when the Pre-Deploy Job (step 5) needs it — you're just doing
that part of the setup early.

Update **`BACKEND_URL`** and **`FRONTEND_URL`** for now to whatever's
actually reachable at this stage — you don't have `api.trussen.app` or
`trussen.app` live yet (that's step 8+ in `deployment-process.md`).
Leaving them as your local placeholder values is fine temporarily; you'll
flip both to the real domains once DNS is live, same as `deployment-process.md`
§12.10 already says.

---

## 5. Deploy, then verify `/health` before doing anything else

Click **Create Resources** / **Deploy**. First build will take a while —
`setup-3-dockerfile.md` clocked the equivalent local build at ~12 minutes
cold — DO's is comparable.

Once it's live, DO gives you a default URL like
`https://trussen-api-xxxxx.ondigitalocean.app`. Confirm:

```bash
curl https://trussen-api-xxxxx.ondigitalocean.app/health
```

Expect:
```json
{"success":true,"data":{"status":"ok","db":"connected", ...}}
```

If this fails, check the **Runtime Logs** tab for that component first —
the two known failure modes from local testing
(`setup-3-dockerfile.md` §5) were a missing `docs/` source file (already
fixed) and quoted env var values (already fixed) — if it's neither of
those, the logs will say specifically which env var or connection failed.

Also check the `ai-worker` component's logs directly (it has no public URL
to curl) — confirm it logs a successful Redis connection and doesn't crash
loop on boot.

---

## 6. Add the Pre-Deploy Job — only after step 5 actually works

DO dashboard → your app → Settings → the **`api`** component → **Pre-Deploy
Job** → add one with run command:

```bash
npx prisma migrate deploy
```

From this point on, every future push to `feat/ai-agent-redesign` (or
`main`, once you repoint it) triggers a rebuild that runs this job first,
applying any new migrations before the new code goes live — you never run
`migrate deploy` by hand again after this (that was the one-time bootstrap
in `step-4-migration-neon.md`).

---

## 7. What's next

Backend is live and reachable at the DO default URL. Don't touch DNS or
Cloudflare yet — `deployment-process.md` §12.7 has you deploy the frontend
to Vercel next, pointed at this same DO default URL (not the custom domain
— that comes later), and confirm login and core flows work end to end
before either side gets a real domain.
