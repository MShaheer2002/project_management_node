# Step 2 — Redis on Upstash

Second thing to set up, after the database (`steup-1-db-neon.md`). Needed
before the AI background worker does anything useful — without it, the
worker boots but silently never processes a job.

---

## Why Upstash instead of DigitalOcean Managed Redis

Same reasoning as swapping Postgres for Neon: DO Managed Redis (Valkey) is
priced like DO's other managed databases, roughly **$15/mo minimum** — real
money to spend before you have a single real user. Upstash has a genuine
free tier that's actually a good fit here, arguably a better fit than
Neon was for Postgres:

- **Free tier**: 500,000 commands/month, 256 MB, 10 GB bandwidth.
- **Standard Redis protocol** — `ioredis` (what this app uses, via
  `infra/queue/redis.ts`) connects to it like any other Redis. No code
  changes, no new library.
- Officially documented to work with BullMQ (Upstash publishes their own
  integration guide) — this isn't an unsupported workaround.

**The one caveat to know:** BullMQ polls Redis continuously even when no
jobs are running (it's how the library watches for new work). That adds up
in command count over a month. On the **free** tier this is very unlikely
to bite at early-stage traffic — 500k/month is a lot of headroom. It only
becomes a real cost concern if you're on Upstash's *paid*, pay-per-command
tier with meaningful traffic. Something to watch later, not a blocker now.

Also unlike Neon, there's no "pooled vs direct" split for Redis — one
connection string, one env var (`REDIS_URL`), done.

---

## 1. Create the database

1. [upstash.com](https://upstash.com) → sign up (free, no credit card
   needed for the free tier) → **Create Database**.
2. **Type**: Redis.
3. **Name**: `trussen`.
4. **Region**: pick the same region as the Neon database from step 1 (this
   project used Singapore / `ap-southeast-1`) — keeping the database and
   the queue backend close together keeps round-trips short. Doesn't need
   to match DigitalOcean's region the way Redis *would* have if you'd
   stuck with DO Managed Redis (that pairing got you free private
   networking; this pairing is just about physical distance).
5. Create it.

---

## 2. Get the connection string

Upstash shows several connection formats (REST API, `.env` snippet for
various frameworks, etc.) — for this app, you want the plain **Redis**
connection string, not the REST one:

- Look for the one starting `rediss://` (double "s" — that's the TLS
  variant, which is what you want; a single-s `redis://` one without TLS
  may also be shown, don't use that one).
- Copy it in full — it already includes the password and port.

Paste it into `.env.production`:

```bash
REDIS_URL="rediss://default:<password>@<your-db>.upstash.io:6379"
```

That's the only value needed — `REDIS_QUEUE_PREFIX` and everything else
Redis-related in `.env.production` is already filled in and doesn't change
based on which provider you use.

---

## 3. Verify it's actually reachable

Don't just trust the paste — confirm the app can actually talk to it,
the same way the database step did:

```bash
cd project_management_node
node --env-file=.env.production -e "
const Redis = require('ioredis');
const r = new Redis(process.env.REDIS_URL);
r.ping()
  .then((res) => { console.log('PING ->', res); process.exit(0); })
  .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
"
```

Expect `PING -> PONG`. If it hangs or errors, the most common causes are:
pasted the REST URL instead of the Redis one, or a typo in the password
(Upstash's dashboard has a copy button next to the connection string —
prefer that over hand-copying).

Once this passes, the real end-to-end test is letting the actual AI
worker boot against it — `AI_WORKER_HEALTH_PORT` (already set to `9201`)
serves a `GET /health` you can hit locally once the worker process is
running with this same `.env.production`, before ever deploying it.

---

## 4. The one thing to remember later

If background AI features (embeddings, stale-issue digests, etc.) stop
working after this has been running a while with real traffic, check two
things in order: first, whether Upstash's free-tier command quota for the
month has been exhausted (Upstash's dashboard shows current usage against
the limit) — that's the failure mode unique to this specific setup, and it
looks like "the worker is just quietly doing nothing" rather than a clear
error. Second, the usual `REDIS_URL` wrong/expired check that would apply
to any Redis provider. If the free tier's quota becomes a real limit,
upgrading Upstash's plan is a much smaller jump than moving providers.
