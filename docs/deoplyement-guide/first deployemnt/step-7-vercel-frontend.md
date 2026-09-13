# Step 7 — Frontend on Vercel

Seventh thing to do. Backend is confirmed live on DigitalOcean
(`step-6-do-deployed.md`) — `api` + `ai-worker`, both healthy, Bull Board
reachable. This step deploys `project_management_react` and points it at
that backend, still using DO's **default URL**, not a custom domain yet —
same reasoning as the backend: prove the app itself works end to end
before introducing DNS as a second variable.

This doc lives in the backend repo's deployment guide folder (there's no
equivalent folder in the frontend repo yet) since it's the continuation of
the same first-deployment sequence.

---

## 0. Branch setup (done)

Frontend repo now matches the backend repo's structure: `dev` is where you
work, `main` is what gets deployed. Both were fast-forwarded from
`feat/ai-agent-redesign` (the branch that actually had all the app code —
`main` was previously just Vite's default scaffold) and pushed. Point
Vercel at **`main`**.

---

## 1. Fix `.env.production` before deploying (done locally, not committed — gitignored)

Two things were wrong in this repo's `.env.production` and have been
corrected:

1. **`VITE_STRIPE_PUBLISHABLE_KEY` was empty.** Filled in with the
   `pk_test_...` key that matches the backend's `STRIPE_SECRET_KEY`
   (`sk_test_...` — Stripe is intentionally in test mode for now, not live;
   both sides must always be the same mode or checkout breaks outright).
2. **`BASE_URL` pointed at `https://api.trussen.app`**, which doesn't
   resolve yet. Changed to DO's actual default URL:
   ```
   BASE_URL=https://trussen-backend-lhqrh.ondigitalocean.app
   ```
   This gets flipped back to `https://api.trussen.app` once Cloudflare DNS
   is live (§12.8-10 in the backend's `deployment-process.md`).

**The 4 env vars Vercel needs** (confirmed against `vite.config.ts` and
`.env.example` — this app only exposes `BASE_URL`/`CLERK_PUBLISHABLE_KEY`
via an explicit `define` block in `vite.config.ts`, not the usual `VITE_`
prefix convention; the other two use Vite's standard auto-exposed prefix):

```bash
BASE_URL=https://trussen-backend-lhqrh.ondigitalocean.app
CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudHJ1c3Nlbi5hcHAk
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_51Tdw0G1iF58bBFeK1SUNOlvWTsXN3rjhKbfAuGJrWCPkxF8E9HGZvzSgLojIzD1Gq1CrOAaFyJQAUVQdlU0Ncp7P00ffnzKRs4
VITE_GOOGLE_CLIENT_ID=63029520470-fkjkis12s7jaqb6kdhp324p62q80hko2.apps.googleusercontent.com
```

None of these are secret in the traditional sense — publishable keys and a
client ID are designed to end up in the shipped browser bundle either way.
Nothing here needs to be marked "Sensitive" in Vercel, though there's no
harm doing so.

---

## 2. Import the project into Vercel

1. [vercel.com](https://vercel.com) → **Add New** → **Project**.
2. Import `project_management_react` from GitHub (authorize Vercel's
   GitHub App if this is the first time, scoped to just this repo).
3. **Framework Preset**: should auto-detect **Vite**. Confirm it did —
   if not, select it manually.
4. **Production Branch**: set to **`main`** (Vercel defaults to whatever
   the repo's default branch is on GitHub — confirm it's `main`, not
   `feat/ai-agent-redesign` or `dev`).
5. **Root Directory**: leave as the repo root (this isn't a monorepo).
6. **Environment Variables**: add the 4 keys from §1 above. Vercel has a
   "paste .env contents" option in this same screen (similar to DO's Bulk
   Editor) — faster than typing each one.
7. Click **Deploy**.

First build should be quick — this is a static Vite build (`vite build` →
static assets), not a Docker build like the backend. Expect well under a
minute once dependencies are cached, a few minutes cold.

---

## 3. Verify before doing anything else

Vercel gives a default URL like `https://project-management-react-xxxx.vercel.app`.

1. Open it. Confirm the marketing/landing page loads (this is the bare,
   no-subdomain route — matches local `localhost:3000/marketing` behavior).
2. Try a real login with an existing account. Confirm it reaches
   `/dashboard` and the AuthSync flow resolves correctly.
3. Open browser dev tools → Network tab → confirm API calls are going to
   `https://trussen-backend-lhqrh.ondigitalocean.app`, not `localhost:8000`
   or an ngrok URL — this is `BASE_URL` actually taking effect.
4. Click around a few core flows (create an issue, view a project) to
   confirm the frontend-backend round trip works for real, not just that
   both sides individually respond.

**What won't work yet, expected:** per-company subdomains
(`acme.vercel.app` isn't a thing Vercel gives you on its default domain) —
that only becomes real once `*.trussen.app` is wired up in Cloudflare/Vercel
custom domains (§12.8-9 of `deployment-process.md`). Testing subdomain
routing specifically still has to happen locally
(`*.localhost:3000`) or after DNS is live, not on this Vercel preview URL.

---

## 4. What's next

Once login and core flows are confirmed working end to end on Vercel's
default URL talking to DO's default URL, per `deployment-process.md`
§12.8-11:

1. Move `trussen.app`'s nameservers to Cloudflare, add the DNS records
   (§5) — `trussen.app`/`*.trussen.app` → Vercel (DNS-only), `api.trussen.app`
   → DO (proxied).
2. Add the custom domains in both Vercel and DO once DNS propagates.
3. Flip `FRONTEND_URL` (backend) and `BASE_URL` (frontend) over to the real
   domains, redeploy both sides.
4. Only then turn on real per-company subdomain testing against the live
   domain.

Also still pending from the backend side (`step-6-do-deployed.md`): the
Pre-Deploy Job for automatic migrations, and the Neon backup-restore drill
— neither is blocking the frontend work, both should happen before real
customers.
