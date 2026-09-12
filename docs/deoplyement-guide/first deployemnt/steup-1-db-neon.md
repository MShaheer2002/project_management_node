# Step 1 — Database on Neon

This is the first thing to deploy (everything else needs `DATABASE_URL` to
even boot). Written so future-you can redo this from scratch without
re-deriving any of it.

---

## 1. Create the Neon project

1. [neon.com](https://neon.com) → sign up (free) → **Create Project**.
2. **Project name**: `Trussen`.
3. **Region**: pick based on where your users/testers actually are — there's
   no "change it later" without recreating the project, so this is the one
   field worth pausing on. No strong default here; match it to your actual
   audience.
4. **Postgres version**: leave the default (**18** at the time of writing).
   Confirmed working — your local dev DB already runs Postgres 18.4 with the
   same `pgvector` extension this schema needs, so there's no compatibility
   concern. Anything 14+ would also work; no reason to downgrade.
5. **Database name**: leave the placeholder (`neondb`) — purely a label,
   doesn't affect anything, not worth spending a decision on.
6. **Neon Auth toggle**: leave it **off**. That's Neon's own bundled
   auth product — you're already using Clerk, turning this on would just
   add a second, unused auth system.
7. Click create.

---

## 2. You'll get TWO connection strings — pooled and direct

This is the part that's easy to get wrong, because it's not obvious *why*
there are two, and this project's Prisma setup (Prisma 7) makes it even
less obvious where each one actually goes — neither lives in
`schema.prisma` anymore.

**Why two exist at all:** Neon's *pooled* connection routes through
PgBouncer (transaction-mode pooling) so your app can handle bursts of
concurrent requests without exhausting Postgres's own connection limit.
But Prisma Migrate (schema changes) needs session-level Postgres features
(advisory locks, certain prepared statements) that a transaction-mode
pooler doesn't support — so migrations need the *direct*, unpooled
connection instead. Every serious Neon+Prisma setup uses both,
simultaneously, for different things.

**Where each one actually goes in THIS project** (verified by reading the
actual code, not assumed):

| Connection string | Env var | Used by | Why |
|---|---|---|---|
| **Pooled** (hostname has `-pooler` in it) | `DATABASE_URL` | `shared/utils/prisma.ts` — the running app (API + AI worker), via `@prisma/adapter-pg` | Every real request the app serves — needs to handle concurrent traffic well |
| **Direct** (no `-pooler`) | `DIRECT_URL` | `prisma.config.ts` — the Prisma CLI (`migrate deploy`, `migrate dev`, `studio`, etc.) | Schema migrations need session-level features the pooler doesn't support |

In Prisma 7, `schema.prisma`'s `datasource` block has no `url` at all — the
CLI's connection comes from `prisma.config.ts`, and the app's own
connection is built directly in code (`shared/utils/prisma.ts`) via a
driver adapter. Two different files, two different env vars, on purpose.

`prisma.config.ts` already handles this (already fixed as of this guide):

```ts
datasource: {
  // DIRECT_URL for migrations; falls back to DATABASE_URL when DIRECT_URL
  // isn't set (local dev, where there's no pooled/direct distinction).
  url: process.env["DIRECT_URL"] || process.env["DATABASE_URL"]!,
},
```

So locally, nothing changes — you only have `DATABASE_URL`, and everything
still works. It's only in Neon-backed environments (production, and any
staging env you point at Neon) that `DIRECT_URL` needs to actually be set.

---

## 3. What to put in `.env.production`

```bash
# Pooled — the app's actual runtime connection
DATABASE_URL="postgresql://<user>:<password>@<project>-pooler.<region>.aws.neon.tech/neondb?sslmode=require"

# Direct — Prisma CLI / migrations only
DIRECT_URL="postgresql://<user>:<password>@<project>.<region>.aws.neon.tech/neondb?sslmode=require"
```

Both come straight from the Neon dashboard — it labels them clearly
("Pooled connection" / "Direct connection"), you're just copying, not
constructing these by hand. `?sslmode=require` should already be on the
end of both; Neon requires SSL and refuses plain connections.

No "trusted sources" step like DO's managed databases have — Neon isn't on
DigitalOcean's private network, so this is a normal authenticated
connection over the public internet, secured by the password in the
connection string plus SSL. Nothing else to configure network-side.

---

## 4. How to actually verify it's connected

Don't just trust that pasting the URL worked — prove it, the same way
you'd verify any new environment:

```bash
# 1. Run the full migration history against the fresh Neon database.
#    This ALSO creates the pgvector/pgcrypto extensions automatically —
#    they're in migration 20260622150000_phase20d_background_infra as
#    `CREATE EXTENSION IF NOT EXISTS "vector"` / `"pgcrypto"`. Nothing to
#    enable by hand first.
DATABASE_URL="<pooled>" DIRECT_URL="<direct>" npx prisma migrate deploy

# 2. Confirm it applied cleanly and matches your migration history.
DATABASE_URL="<pooled>" DIRECT_URL="<direct>" npx prisma migrate status
# Expect: "Database schema is up to date!"

# 3. Confirm the app itself can actually connect and run a real query —
#    point a local .env.production-shaped env at Neon and hit /health:
#    (see deployment-process.md §12 for the full first-deploy sequence)
```

If step 1 fails specifically on the extension-creation lines, that means
Neon's `vector`/`pgcrypto` extensions aren't available in whatever plan/
region you picked — unlikely (they're standard on Neon), but that's the
first thing to check if it happens.

---

## 5. The one thing to remember 6 months from now

If `prisma migrate deploy` starts failing in production with errors about
advisory locks, prepared statements, or "server closed the connection
unexpectedly" during a migration — check that `DIRECT_URL` is actually set
wherever the migration is running from (DO's Pre-Deploy Job env vars,
specifically). That's the signature of a migration accidentally running
through the *pooled* connection instead of the direct one. `DATABASE_URL`
alone being wrong looks like normal query failures; `DIRECT_URL` being
missing looks like migrations mysteriously breaking while the app itself
runs fine — that mismatch is the tell.
