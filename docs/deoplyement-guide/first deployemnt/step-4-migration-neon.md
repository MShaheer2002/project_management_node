# Step 4 — Apply migrations to the production Neon database

Fourth thing to do, after the database (`steup-1-db-neon.md`), Redis
(`steup-2-redis-upstash.md`), and the Dockerfile (`setup-3-dockerfile.md`).
This is the one manual, by-hand step in the whole deployment — everything
after it (creating the DO App Platform app, deploying the frontend) assumes
the schema already exists.

---

## Why this can't be skipped or automated yet

`steup-1-db-neon.md` created the Neon *project* — an empty Postgres
instance, no tables. Docker image and `.env.production` values being
correct doesn't create the schema; only actually running Prisma's migration
history against that specific database does. Confirmed by checking
`prisma migrate status` against it: **59 migrations found, all 59 still
pending** — the project has existed but nothing has ever been applied to
it.

This has to be done by hand exactly once. From then on, DO App Platform's
Pre-Deploy Job (`deployment-process.md` §10) takes over and runs
`prisma migrate deploy` automatically on every future deploy — this file
only covers the one-time bootstrap, before that job exists to do it.

---

## 1. The command

Run this from `project_management_node/`, on a machine that has
`.env.production` populated with the real Neon `DATABASE_URL` (pooled) and
`DIRECT_URL` (direct, unpooled) — see `steup-1-db-neon.md` §2 for which is
which and why both are needed:

```bash
node --env-file=.env.production node_modules/.bin/prisma migrate deploy
```

Using `node --env-file` (not bare `npx prisma migrate deploy`) matters here
— it's what actually loads `.env.production`'s values into the process
environment before Prisma's CLI reads them via `prisma.config.ts`. A bare
`npx prisma migrate deploy` would run against whatever's already in your
shell's environment (or nothing), not this file.

`prisma.config.ts` resolves `DIRECT_URL || DATABASE_URL` for the CLI (see
`steup-1-db-neon.md` §2) — migrations run through the *direct* connection,
never the pooled one, since Neon's pooler doesn't support the
session-level features (advisory locks, certain prepared statements)
`migrate deploy` needs.

---

## 2. What success looks like

```
Datasource "db": PostgreSQL database "neondb", schema "public" at "<project>.<region>.aws.neon.tech"

59 migrations found in prisma/migrations

Applying migration `20260516054613_init`
Applying migration `20260516210115_add_team_size_to_workspace`
...
Applying migration `20260910195646_invite_domain_policy`

All migrations have been successfully applied.
```

This also creates the `vector` and `pgcrypto` Postgres extensions
automatically (they're `CREATE EXTENSION IF NOT EXISTS` statements inside
migration `20260622150000_phase20d_background_infra`) — nothing to enable
by hand first in Neon's dashboard.

Confirm afterward with:

```bash
node --env-file=.env.production node_modules/.bin/prisma migrate status
```

Expect: `Database schema is up to date!`

---

## 3. If it fails partway through

Prisma migrations run in a transaction per migration file, so a failure
stops cleanly at that migration rather than leaving a half-applied one —
but the migrations *before* the failure point stay applied. Re-running the
same `migrate deploy` command after fixing the cause resumes from the
first unapplied one; it does not try to redo migrations that already
succeeded.

Two failure modes worth knowing specifically for this project:

- **Advisory lock / prepared statement errors, or "server closed the
  connection unexpectedly"** — `DIRECT_URL` isn't actually set or is
  pointing at the pooled connection by mistake. Check `.env.production`
  has both values, and that `DIRECT_URL`'s hostname does **not** contain
  `-pooler`.
- **`CREATE EXTENSION` permission errors** — would mean the Neon
  plan/region doesn't have `vector`/`pgcrypto` available. Unlikely (these
  are standard on Neon) but the first thing to check if it happens.

---

## 4. After this succeeds

Don't make this a recurring manual habit — the next step in
`deployment-process.md` (§12.4-5) is creating the DO App Platform app and
adding a **Pre-Deploy Job** (`npx prisma migrate deploy`) on the `api`
component, so every future deploy applies its own migrations automatically
as part of the same pipeline. This file only ever needs to be followed
again if you ever point the app at a brand-new, empty database from
scratch (e.g. a disaster-recovery restore that creates a fresh project
instead of restoring in-place).
