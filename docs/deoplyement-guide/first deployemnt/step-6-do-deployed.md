# Step 6 — Backend live on DigitalOcean (confirmed)

Sixth thing done, after Neon (`steup-1-db-neon.md`), Upstash
(`steup-2-redis-upstash.md`), the Dockerfile (`setup-3-dockerfile.md`),
migrations (`step-4-migration-neon.md`), and creating the app
(`step-5-do-app-platform.md`). This file records what's actually live right
now, not a how-to — it's the checkpoint before moving to the frontend.

---

## What's running

**App**: `trussen-backend`, project **Trussen Backend**, region **sgp1**
(Singapore — picked to sit close to the Neon DB in `ap-southeast-1`).

**Branch**: `main` — this is the deployed branch. Ongoing work happens on
`dev`; ship to production by opening a PR from `dev` into `main` and
merging it, which triggers DO's auto-deploy. Never push directly to `main`.

| Component | Type | Size | Run command | Cost |
|---|---|---|---|---|
| `api` | Web Service | 512 MB / 1 shared vCPU | default (`node dist/app/server.js`) | $5/mo |
| `ai-worker` | Worker | 512 MB / 1 shared vCPU | `node dist/workers/ai-background.worker.js` | $5/mo |

**Total cost: $10/month.**

Both components share the same 70-key environment variable set (pasted via
DO's "Add from .env" bulk import on each component individually, not
app-level — see `step-5-do-app-platform.md` §4 for the full list of which
keys are Encrypted vs plain).

---

## Verification actually performed

**`api`** — confirmed via Runtime Logs and a live `curl`:
```
✅ Database connected
Server running on port 8000 (production mode)
```
```bash
curl https://trussen-backend-lhqrh.ondigitalocean.app/health
```
```json
{"success":true,"data":{"status":"ok","db":"connected","uptime":1256}}
```

**`ai-worker`** — confirmed via Runtime Logs (this component has no public
URL to curl, so logs are the only verification path):
```
[AI Worker] Health endpoint listening on :9201/health
[Bull Board] Queue dashboard listening on :9202
```
Both ports coming up cleanly means the worker connected to Upstash Redis
successfully — `AI_WORKER_HEALTH_PORT` (9201) and `BULL_BOARD_PORT` (9202)
are only reachable internally on DO (no public route configured for a
Worker component), so this confirms the process booted and initialized its
queues without needing to expose anything externally.

Neither component is crash-looping — no repeated restart entries in
Activity.

---

## What this does NOT yet confirm

- **Bull Board itself hasn't been opened** — it's listening, but nobody's
  actually loaded the dashboard UI yet to see real queue state. Not
  necessary to do right now; the health port coming up is sufficient proof
  Redis is reachable. Revisit if a background job ever silently seems to
  not run.
- **No real AI job has been processed end-to-end yet** (no embedding job,
  no digest) — only that the worker process is alive and connected. The
  actual job-processing path is unverified until something in the app
  triggers a real job (e.g. creating an issue if issue-embedding is wired
  to fire on create).
- **The custom domain (`api.trussen.app`) isn't wired up** — everything
  above is verified against DO's own default URL
  (`trussen-backend-lhqrh.ondigitalocean.app`). DNS/Cloudflare comes later
  (`deployment-process.md` §12.8), after the frontend is also live.

---

## What's next

Per `deployment-process.md` §12.6-7: confirm `/health` on the default URL
(done, above), then deploy the **frontend to Vercel next**, pointed at this
same DO default URL (not the custom domain yet) — confirm login and core
flows work end to end before touching DNS at all.

The Pre-Deploy Job (`npx prisma migrate deploy` on the `api` component,
`deployment-process.md` §10) still hasn't been added — do that once the
frontend is also confirmed working, so the first automated migration run
happens as part of a deploy you're already watching closely, not as an
unattended background step on day one.
