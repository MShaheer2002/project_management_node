# Deployment Process — Trussen

This is the concrete, do-it-in-this-order guide for putting the whole
project online. It covers every moving part you currently have — frontend,
backend, database, AI worker, Redis, file storage, real-time (sockets) — and
says exactly where each one lives and why.

Stack chosen: **Vercel** (frontend) + **DigitalOcean App Platform**
(backend, via Docker) + **DigitalOcean Managed PostgreSQL** +
**DigitalOcean Managed Redis** + **Cloudflare** (DNS) + your existing
**AWS S3** (file uploads — no change needed there).

---

## 1. Every moving part, and where it goes

| Piece | What it actually is | Where it runs |
|---|---|---|
| Frontend (React/Vite) | The UI everyone's browser loads | **Vercel** |
| Backend API (Express) | Handles all `/api/...` requests, auth, billing, etc. | **DigitalOcean App Platform** — Web Service |
| Real-time (Socket.IO) | Live updates (notifications, board updates) | **Same backend process** — it's not a separate service, `socket/index.ts` attaches to the same HTTP server as the API |
| AI background worker | Processes queued AI jobs (embeddings, summaries, etc.) — `workers/ai-background.worker.ts` | **DigitalOcean App Platform** — Worker component (same Docker image, different start command) |
| Database | PostgreSQL, holds all app data | **DigitalOcean Managed PostgreSQL** |
| Redis | Job queue backbone for the AI worker (BullMQ) | **DigitalOcean Managed Redis (Valkey)** |
| File storage | Uploaded images/videos/documents | **AWS S3** (already wired up via `AWS_*` env vars — leave as is, no reason to migrate) |
| MCP server (stdio) | Lets Claude Desktop talk to Trussen locally | **Not deployed at all** — it's a local stdio tool (`mcp/server.ts`), separate from the HTTP MCP routes already mounted inside the API (`mcp/mcp.http.routes.js`, mounted in `app/app.ts`). Nothing extra to do here. |
| DNS | Routes `trussen.app`, `*.trussen.app`, `api.trussen.app` | **Cloudflare** |

Two things are easy to miss:
- **Socket.IO is not a separate deploy.** It rides on the same Express
  server (`app/server.ts` creates one `http.Server` and both Express and
  Socket.IO attach to it). One backend service, not two.
- **Redis is not optional once the AI worker is live.** BullMQ (the queue
  library) needs Redis to hand jobs from the API to the worker. Without
  `REDIS_URL` set, `infra/queue/redis.ts` disables the whole queue system
  and just logs a warning — background AI features silently stop working.

---

## 2. The picture, all together

```
                              ┌────────────────────┐
                              │      Cloudflare      │
                              │   (DNS for trussen.app)
                              └──────────┬───────────┘
                     ┌────────────────────┼─────────────────────┐
                     │                    │                     │
        trussen.app / *.trussen.app                      api.trussen.app
           (DNS only, grey cloud)                        (proxied, orange cloud)
                     │                                           │
                     ▼                                           ▼
              ┌─────────────┐                          ┌──────────────────┐
              │    Vercel    │   axios / websocket ───▶ │  DO App Platform  │
              │  (React SPA) │ ◀───────────────────────  │   Web Service:    │
              └─────────────┘                            │  node dist/app/    │
                                                          │   server.js        │
                                                          │  (Express+Socket.IO)│
                                                          └─────────┬─────────┘
                                                                    │
                                        ┌───────────────────────────┼───────────────────────────┐
                                        │                           │                           │
                                        ▼                           ▼                           ▼
                             ┌────────────────────┐     ┌────────────────────┐      ┌────────────────────┐
                             │ DO Managed Postgres │     │   DO Managed Redis  │      │      AWS S3         │
                             └────────────────────┘     └──────────┬─────────┘      │ (file uploads)       │
                                                                    │                └────────────────────┘
                                                                    ▼
                                                         ┌────────────────────┐
                                                         │  DO App Platform    │
                                                         │  Worker component:  │
                                                         │  node dist/workers/ │
                                                         │  ai-background.     │
                                                         │  worker.js          │
                                                         └────────────────────┘
```

One Docker image, built once from `project_management_node`, runs as
**two** components on DigitalOcean — a Web Service and a Worker — just with
different start commands. Same code, same env vars, no duplication.

---

## 3. Docker — one Dockerfile, two roles

You only need one `Dockerfile` in `project_management_node/`. DO App
Platform builds it once and reuses the image for both the API and the
worker — you just tell each component which command to run.

```dockerfile
# project_management_node/Dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build          # tsc → dist/

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/app/generated ./app/generated
COPY --from=build /app/prisma ./prisma
EXPOSE 8000
CMD ["node", "dist/app/server.js"]
```

- The **Web Service** component uses the default `CMD` above.
- The **Worker** component overrides the run command in DO's dashboard to:
  `node dist/workers/ai-background.worker.js`

Skipped: separate Dockerfiles per service, docker-compose for production
— one image + two run commands is simpler and there's nothing here that
needs to diverge. Add a docker-compose file only if you want to run
Postgres+Redis+API locally for development (that's a reasonable next step,
just not a production deployment concern).

---

## 4. DigitalOcean setup

### 4a. Managed PostgreSQL
Create it first — everything else needs `DATABASE_URL`.
1. DO dashboard → Databases → Create → PostgreSQL.
2. Pick the region closest to where your App Platform app will run (they
   must be in the same DO region to talk over the private network — faster
   and free of bandwidth charges).
3. Copy the connection string it gives you → this becomes `DATABASE_URL`.
4. Add your App Platform app to the database's "trusted sources" once it
   exists (step 4c) so only your app can connect, not the open internet.

### 4b. Managed Redis (Valkey)
1. DO dashboard → Databases → Create → Valkey (DO's Redis-compatible
   managed offering — same protocol, `ioredis` doesn't know the difference).
2. Same region as Postgres and the app.
3. Copy the connection string → this becomes `REDIS_URL`.

### 4c. App Platform — the app itself
1. DO dashboard → App Platform → Create App → connect your GitHub repo,
   pick the `project_management_node` folder as the source (App Platform
   supports "Dockerfile" as the build method directly — pick that instead
   of buildpacks).
2. It will detect one component from the Dockerfile. Configure it as:
   - **Name:** `api`
   - **Type:** Web Service
   - **HTTP Port:** `8000`
   - **Health check path:** `/health` (already exists — `app/app.ts:142`)
3. Add a second component (Add Component → from the same source/Dockerfile):
   - **Name:** `ai-worker`
   - **Type:** Worker (no public HTTP port needed)
   - **Run Command override:** `node dist/workers/ai-background.worker.js`
4. Attach the Postgres and Redis databases from step 4a/4b to the app (DO
   lets you "attach" a managed database to an App Platform app — it
   injects the connection string as an env var automatically, or you paste
   it manually into step 5 below).
5. Set environment variables (see the checklist in section 7) on **both**
   components — they share the same `.env` shape since it's the same image.
6. Deploy. DO gives you a default URL like
   `trussen-api-xxxxx.ondigitalocean.app` — you'll point your real domain
   at this in section 5.

Why App Platform over a raw Droplet: it handles TLS certificates, restarts
on crash, zero-downtime redeploys, and horizontal scaling for you. A
Droplet + docker-compose + Nginx + Certbot does the same job but is work
you'd be maintaining by hand for no functional gain at this stage. Revisit
Droplets only if you outgrow App Platform's pricing or need OS-level
control it doesn't expose.

---

## 5. Domains & DNS (Cloudflare)

Move `trussen.app`'s nameservers to Cloudflare (free plan is enough), then:

| Record | Type | Points to | Proxy status |
|---|---|---|---|
| `trussen.app` | CNAME/ALIAS | Vercel (Vercel gives you the exact target when you add the domain) | **DNS only** (grey cloud) |
| `*.trussen.app` | CNAME | same Vercel target | **DNS only** (grey cloud) |
| `api.trussen.app` | CNAME | `trussen-api-xxxxx.ondigitalocean.app` | **Proxied** (orange cloud) |

Cloudflare proxying (orange cloud) in front of Vercel *can* be made to
work — it's a supported setup if you configure the SSL mode and Vercel's
domain verification correctly. It's just extra configuration for no real
benefit here, since Vercel already runs its own global CDN and issues its
own certs. So the recommendation is DNS-only (grey) for the frontend
records not because proxying it is broken, but because it buys you
nothing — Cloudflare is only doing useful extra work on the `api.trussen.app`
record, where your origin (DO, one region) doesn't already have a global
edge in front of it.

Why `api.trussen.app` **should** be proxied (orange): Cloudflare's global
network terminates the connection closer to the visitor worldwide (this is
your "accessible quickly worldwide" ask for the API specifically — your DO
app itself is running in one region, but Cloudflare's edge shaves off
connection setup time for users far from it) and gives you free DDoS
protection in front of your backend. Set Cloudflare's SSL mode to **Full
(strict)** so it still verifies DO's certificate rather than trusting
anything.

> Note: `*.trussen.app` as a custom domain on Vercel requires a **Pro**
> plan (wildcard custom domains aren't available on the free Hobby plan).
> Worth checking before you rely on this.

This is exactly the DNS piece described in
`subdomain-routing-explained.md` — one wildcard record, done once, covers
every company subdomain forever.

---

## 6. Vercel setup (frontend)

1. Import `project_management_react` as a Vercel project (framework
   preset: Vite).
2. Environment variables (Project Settings → Environment Variables):
   - `BASE_URL` = `https://api.trussen.app`
   - `CLERK_PUBLISHABLE_KEY`
   - `VITE_STRIPE_PUBLISHABLE_KEY`
   - `VITE_GOOGLE_CLIENT_ID` (if Google Drive integration is enabled)
3. Add custom domains: `trussen.app` and `*.trussen.app`, plus a redirect
   from `www.trussen.app` if you want it.
4. Every push to `main` auto-deploys — nothing else to configure.

---

## 7. Environment variables checklist (backend)

Every variable in `config/env.ts` is validated at startup — the app
refuses to boot if a required one is missing, so this list is authoritative
for what DO needs configured on **both** the `api` and `ai-worker`
components:

**Required:** `DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
`CLERK_WEBHOOK_SECRET`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_STANDARD_MONTHLY_PRICE_ID`,
`STRIPE_PREMIUM_MONTHLY_PRICE_ID`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET`

**Required for this to be a real production deployment:**
`NODE_ENV=production`, `FRONTEND_URL=https://trussen.app`,
`BACKEND_URL=https://api.trussen.app`

**Required once the AI worker matters:** `REDIS_URL` (from step 4b) —
without it, background AI jobs silently never run.

**Optional / feature-gated:** everything under GitHub/Slack/Google Drive/
OpenRouter/AI model config — only needed if those integrations are turned
on. Leave them unset until you actually wire up that integration.

Store these as **encrypted** env vars in DO's dashboard (App Platform
supports this natively) — never commit `.env` to git.

---

## 8. Required code changes before subdomains actually work in production

Two files currently assume there's exactly **one** frontend origin, which
breaks the moment `fissiontech.trussen.app` and `acme.trussen.app` both
need to talk to the same API:

- **`config/cors.ts`** — in production, `origin` is hardcoded to the single
  `env.FRONTEND_URL` string. It needs to become a pattern match, the same
  way the *development* branch already does it (`origin.endsWith(".ngrok-free.dev")`
  is the shape to copy) — e.g. `origin.endsWith(".trussen.app") || origin === "https://trussen.app"`.
- **`socket/index.ts`** (`isAllowedOrigin`) — same issue, same fix, for
  Socket.IO's own CORS check.

Without this, browsers on any company subdomain will get CORS errors
calling the API and the real-time connection will silently fail. This is
a small, contained change — happy to make it whenever you're ready to flip
subdomains on.

One more thing to know, not fix now: if you ever scale the `api` component
past **1 instance**, Socket.IO needs a Redis adapter
(`@socket.io/redis-adapter`) so a "join room" event on instance A is seen
by a socket connected to instance B. At 1 instance this doesn't matter —
flag it for later, not today.

---

## 9. Subdomain routing tells you the tenant — it does not authorize anyone

This is a distinction worth being explicit about, because getting it wrong
in a project-management SaaS means one company can see another's data.

`acme.trussen.app` in the `Host` header only tells the backend **which
workspace the request claims to be for.** It says nothing about **who is
making the request** or **whether they're allowed into that workspace.**
Those are two separate questions answered by two separate mechanisms:

```
Host: acme.trussen.app
        │
        ▼
  "which workspace?"  →  resolve slug "acme" → Workspace row (routing)
        │
        ▼
  "who is asking?"    →  Clerk session / JWT → authenticated User (authentication)
        │
        ▼
  "are they allowed in THIS workspace?" → WorkspaceMembership lookup (authorization)
        │
        ▼
  only if both check out → serve the request
```

The authorization step already exists in this codebase — it just isn't
wired to the `Host` header yet. `shared/middleware/require-workspace.ts`
resolves the workspace from a header/param, but the actual "is this user
a member of this workspace" check needs to happen on every request
regardless of *how* the workspace was identified. When you wire up
subdomain-based routing (section 8), the subdomain becomes just another way
to *find* the workspace — it must feed into the same membership check that
already exists, never bypass it. Never treat "the request arrived on
`acme.trussen.app`" as proof the caller belongs to Acme.

---

## 10. Database migrations

Prisma migrations need to run against the production database before the
new API code that depends on them goes live.

**For the very first deploy**, the schema doesn't exist yet, so there's no
way around running it once by hand before the app can even boot:

```bash
DATABASE_URL="<production connection string>" npx prisma migrate deploy
```

**From then on, don't make this a recurring manual habit.** A migration
that only exists because someone remembered to run it from their laptop is
a migration that eventually gets forgotten, and production breaks in a way
that's confusing to debug (API code expecting a column that was never
added). Set up DO App Platform's **pre-deploy job** right after the first
successful deploy — a command that runs once, automatically, before the
new version takes traffic:

- DO dashboard → your app → Settings → the `api` component → add a
  **Pre-Deploy Job** with run command `npx prisma migrate deploy`.

From that point, every deploy runs its own migration automatically, in the
same pipeline as the code that depends on it — not from your laptop, not
as a step you might skip.

---

## 11. Backups & disaster recovery

"I turned on backups" is not a backup strategy — a backup you've never
restored is an assumption, not a plan. Do these explicitly:

1. **Automated backups are already on by default** — DO takes a daily
   backup of every Managed PostgreSQL cluster automatically, no setup
   needed. Confirm it in the dashboard anyway — Databases → your cluster →
   Backups.
2. **Point-in-time recovery (PITR) is also included by default** — DO
   keeps WAL (write-ahead log) archives alongside the daily backup, so you
   can restore to any specific second, not just the last nightly snapshot.
   This matters for "a bad migration or bug corrupted data 3 hours ago" —
   a nightly-only backup would still lose those 3 hours; PITR doesn't.
   **The one real limit to know:** the whole retention window is a fixed
   **7 days**, on every plan, with no dashboard option to extend it. If you
   ever need to keep data recoverable for longer than a week (common for
   compliance, or just peace of mind once you have paying customers), that
   means a separate periodic `pg_dump` exported to S3 on your own schedule
   — DO's built-in backups don't cover that by themselves.
3. **Actually run a restore, once, before you need it for real:**
   - Trigger a restore-to-new-cluster from a backup (DO supports restoring
     into a *new* database instance without touching production).
   - Point a local `DATABASE_URL` at that restored instance.
   - Run `npx prisma migrate status` and a few real queries (e.g. does a
     known workspace/user exist with the right data) to confirm it's not
     just "a database came up" but "the data is actually there and
     correct."
   - Tear the test instance down afterward.
4. **Write down the restore procedure** (even a few lines: where to click
   in DO, what connection string to use, who's allowed to trigger a
   production restore) — the point of a disaster recovery plan is that it
   works when someone is stressed at 2am, not that it lives only in
   someone's memory of doing it once.

Do step 3 at least once before you have real customer data, and again
after any major schema change — an untested restore path is the kind of
thing that only reveals it's broken at the worst possible time.

---

## 12. First-time deploy order (do it in this order)

1. Create the Managed PostgreSQL database (section 4a) with automated
   backups on (section 11).
2. Run `npx prisma migrate deploy` against it once, locally, to create the
   schema — this is the one and only time this runs manually (see
   section 10).
3. Create the Managed Redis instance (section 4b).
4. Create the App Platform app with the `api` and `ai-worker` components
   (section 4c), pointed at the Postgres/Redis from steps 1 and 3.
5. Add the Pre-Deploy Job (`npx prisma migrate deploy`) to the `api`
   component now, so every deploy from here on handles its own migrations
   (section 10).
6. Confirm `https://<the-do-default-url>/health` responds before touching
   DNS.
7. Deploy the frontend to Vercel (section 6), pointed at that same DO
   default URL first (not the custom domain yet) — confirm login and core
   flows work end to end.
8. Move `trussen.app`'s nameservers to Cloudflare and add the DNS records
   (section 5).
9. Add the custom domains in both Vercel and DO once DNS has propagated.
10. Flip `FRONTEND_URL`/`BASE_URL` env vars over to the real domains and
    redeploy both sides.
11. Make the CORS/Socket.IO changes in section 8, wire subdomain
    resolution into the same membership check described in section 9, and
    turn on per-company subdomains.
12. Run the backup-restore drill from section 11 before onboarding real
    customers.

Each step is independently verifiable — don't move to the next one until
the current one actually works, since debugging "DNS + CORS + a new
database" all at once is the hard way to do this.
