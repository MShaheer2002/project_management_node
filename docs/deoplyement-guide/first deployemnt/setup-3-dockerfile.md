# Step 3 — Dockerfile

Third thing set up, after the database (`steup-1-db-neon.md`) and Redis
(`steup-2-redis-upstash.md`). This is what DigitalOcean App Platform will
actually build and run — both the API and the AI worker come from this
one file.

Tested end-to-end on this machine before writing this doc — every command
below was actually run, including hitting two real bugs and fixing them.
Not a theoretical walkthrough.

---

## 1. Why one Dockerfile for two different processes

This app runs as two separate processes in production — the API server
and the AI background worker (`workers/ai-background.worker.ts`) — but
they're the exact same codebase, same dependencies, same compiled output.
Only the *last command* differs. So instead of two Dockerfiles that would
drift out of sync over time, there's one image, and each role just
overrides the command it starts with:

```
Dockerfile → docker build → ONE image
                                │
                ┌───────────────┴───────────────┐
                ▼                               ▼
   node dist/app/server.js          node dist/workers/ai-background.worker.js
   (the default CMD)                 (override at run time)
```

---

## 2. The Dockerfile, section by section

```dockerfile
FROM node:25-slim AS build
WORKDIR /app
```
Two-stage build. `node:25-slim` matches your local Node version exactly
(confirmed working with this codebase already) — `-slim` means Debian
underneath, not Alpine. That matters specifically for Prisma: Alpine uses
a different C library (musl) that historically causes extra headaches with
Prisma's engine binaries. Debian avoids that whole category of problem.

This first stage is called `build` — it's temporary, thrown away at the
end. Its only job is to produce compiled JavaScript. It's never what
actually runs in production.

```dockerfile
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
```
Prisma's CLI (the part that runs migrations) needs OpenSSL available, even
though — worth knowing — Prisma 7's actual query engine (what your running
app uses to talk to Postgres) doesn't need it anymore. This project already
uses Prisma 7's newer driver-adapter mode (`@prisma/adapter-pg`, visible in
`shared/utils/prisma.ts`), which talks to Postgres via the plain `pg`
library instead of Prisma's old Rust binary engine. That's why this
Dockerfile is simpler than most Prisma Docker guides you'll find online —
no `binaryTargets` configuration, no platform-specific engine downloads to
worry about. OpenSSL is still installed defensively for the CLI/migration
side, which is a separate, older code path.

```dockerfile
COPY package*.json ./
RUN npm ci
```
Copying just `package.json`/`package-lock.json` *before* the rest of the
code is deliberate, not an accident — Docker caches each step, and only
re-runs a step if its inputs changed. Since dependencies change far less
often than your source code, this means `npm ci` (the slowest step, ~8
minutes on a cold cache) gets skipped on almost every rebuild — only
re-running when `package.json` actually changes. You saw this yourself: the
second build, after only fixing `.dockerignore`, finished in under a
minute because everything up to `COPY . .` was `CACHED`.

```dockerfile
COPY . .

ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN npx prisma generate
RUN npm run build
```
Now the rest of the source code gets copied in, `prisma generate` produces
the typed Prisma Client (`app/generated/prisma/*.ts`), and `tsc` compiles
everything — including those generated files — into `dist/`.

The placeholder `DATABASE_URL` exists only because `prisma.config.ts`
reads `process.env["DIRECT_URL"] || process.env["DATABASE_URL"]!` and
needs *some* string there to not blow up — `prisma generate` never
actually connects to a database, it only reads `schema.prisma` and writes
TypeScript, so a fake value is harmless. The real credentials come from
DO's environment variables at actual runtime, never from this build step.

```dockerfile
FROM node:25-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev
```
Second, separate stage — this one is what actually ships and runs. Fresh
`npm ci --omit=dev` here (not reused from the build stage) means dev-only
tools like `typescript` never end up in the final image, keeping it
smaller. `prisma` (the CLI) is a *regular* dependency in this project's
`package.json`, not a dev one — confirmed before writing this — so it
survives `--omit=dev` and is still available in this final image for
running migrations later.

```dockerfile
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
```
Only three things get pulled from the `build` stage:
- `dist/` — the compiled app. This already includes the compiled Prisma
  Client (`dist/app/generated/prisma/*.js`) — confirmed by checking that
  `tsc` follows the import from `shared/utils/prisma.ts` and compiles it,
  *despite* `app/generated` being in `tsconfig.json`'s `exclude` list.
  `exclude` only controls the initial file list, not files reached via
  imports — so no separate copy step for the generated client is needed.
- `prisma/` (schema + all migrations) and `prisma.config.ts` — needed so
  `npx prisma migrate deploy` can run from *this same image* later (DO's
  Pre-Deploy Job). `prisma.config.ts` is copied as a raw `.ts` file on
  purpose — Prisma's CLI reads it directly, it's never compiled by `tsc`
  (it's not in `tsconfig.json`'s `include` list either).

```dockerfile
EXPOSE 8000
CMD ["node", "dist/app/server.js"]
```
Default command starts the API. The Worker component in DO's dashboard
overrides this one line to `node dist/workers/ai-background.worker.js` —
same image, nothing else changes.

---

## 3. `.dockerignore` — and the bug it caused

```
node_modules
dist
app/generated
.git
.env
.env.*
!.env.example
*.log
.DS_Store
```

This file controls what `COPY . .` is allowed to see. The important line
is `.env` / `.env.*` — without this, your real secrets (`.env.production`
included) would get copied straight into the image, baked into a layer
permanently, even if a later step "deleted" them. Anyone with the image
could extract them. This is the actual reason `.dockerignore` exists here,
not just build speed.

**The bug we hit:** this file originally also had a line for `docs` —
the reasoning was "that's just markdown, no need to copy it." That broke
the build with:
```
error TS2307: Cannot find module '../docs/api/openapi.js'
```
Turns out `docs/api/openapi.ts` isn't documentation — it's real source
code (the Swagger API spec) that `app/app.ts` actually imports. Excluding
the whole `docs/` folder excluded that file too. Fix: removed the `docs`
line entirely — markdown files are tiny, there was no real cost to
including them anyway. **The lesson:** don't exclude a folder by its name
if you haven't checked everything inside it is actually what the name
implies.

---

## 4. Building and testing it

```bash
docker build -t trussen-api-test .
```
First build: ~12 minutes (pulling the base image + `npm ci` twice, once
per stage, with nothing cached yet). Every build after that reuses cached
layers for anything that didn't change — expect seconds, not minutes, for
a source-code-only change.

**Test the API role:**
```bash
docker run --rm -p 8000:8000 --env-file .env.production trussen-api-test
```
then, in a second terminal:
```bash
curl http://localhost:8000/health
```
Expect `{"success":true,"data":{"status":"ok","db":"connected",...}}`.
This proves the container can reach Neon and boot correctly — it does NOT
prove your schema exists yet (migrations haven't run against Neon at this
point in the process), and that's fine: `/health` runs a literal `SELECT 1`,
which doesn't touch any table, so it succeeds on a completely empty
database just as well as a fully-migrated one.

**Test the worker role — same image, different command:**
```bash
docker run --rm -p 9201:9201 --env-file .env.production trussen-api-test node dist/workers/ai-background.worker.js
```
```bash
curl http://localhost:9201/health
```
`-p 9201:9201` because the worker doesn't serve the API at all — it only
exposes `AI_WORKER_HEALTH_PORT` for liveness checks. This is exactly how
DO will run the `ai-worker` component later: same image, this same
command override, configured once in DO's dashboard instead of typed by
hand.

---

## 5. The second bug we hit: `--env-file` and quotes

Redis failed validation the first time the container ran:
```
❌ Invalid environment variables:
{ REDIS_URL: { _errors: [ 'Invalid URL' ] } }
```
Cause: `.env.production` had values written as `REDIS_URL="rediss://..."`
— quoted, the normal `.env` convention. **Node's** `--env-file` flag (and
the `dotenv` package) strip those quotes automatically, which is why the
same file worked fine for local Node commands (`node --env-file=.env.production ...`,
confirmed with a working Redis `PING -> PONG` earlier). **Docker's**
`--env-file` flag does not strip them — it handed the app the literal
string `"rediss://...` (leading quote character included), which isn't a
valid URL.

The scarier part: `DATABASE_URL` had the identical problem and didn't get
caught by validation (its check only requires "any non-empty string," not
"a valid URL") — it would have silently tried to connect to a broken,
quote-mangled connection string.

**Fix:** removed the quotes from every value in `.env.production`
entirely. Confirmed this doesn't break the Node-based commands (they
handle quoted and unquoted values identically) — so the file now works
correctly with both `node --env-file` and `docker run --env-file`.

**The lesson to remember:** never quote values in a file meant to be read
by `--env-file` (Docker's, specifically) — plain `KEY=value`, always. This
will matter again when configuring env vars for DO App Platform if you
ever import them from a file rather than typing each one into their UI.

---

## 6. What's next

The image builds, and both roles (API, worker) boot correctly against the
real production database and Redis. Nothing has been deployed anywhere
yet — this was all local verification. Next: create the actual DO App
Platform app (deployment-process.md §4c), which builds this same
Dockerfile in the cloud and runs it as the `api` and `ai-worker`
components.
