# Step 8 — Cloudflare DNS: Clerk custom domain + Vercel custom domain

Eighth thing done, after Vercel frontend (`step-7-vercel-frontend.md`). This
happened earlier than `deployment-process.md`'s original §12 order intended
(DNS was planned for *after* confirming the app on default URLs) — turned
out to be unavoidable, not a shortcut: Clerk's **Production** instance
rejects any request whose origin isn't `trussen.app` or a subdomain of it,
so login could never be tested on `trussen-theta.vercel.app` at all. DNS had
to happen before real login testing was possible, not after.

---

## What's live now

**Domain**: `trussen.app`'s nameservers already pointed at Cloudflare
before this session (unclear when/who did this originally) — only the
actual DNS records were missing.

**Clerk custom domain** (`clerk.trussen.app`, `accounts.trussen.app`, plus
email/DKIM) — set up via Clerk's dashboard (Configure → Domains →
`trussen.app` → Configure → **Automatic DNS setup**, which uses
Cloudflare's Domain Connect to add all 5 records in one authorized flow
instead of typing them by hand):

| Record | Type | Target |
|---|---|---|
| `clerk` | CNAME | `frontend-api.clerk.services` |
| `accounts` | CNAME | `accounts.clerk.services` |
| `clkmail` | CNAME | `mail.ewtjfhffrudg.clerk.services` |
| `clk._domainkey` | CNAME | `dkim1.ewtjfhffrudg.clerk.services` |
| `clk2._domainkey` | CNAME | `dkim2.ewtjfhffrudg.clerk.services` |

All 5 set to **DNS only** (grey cloud) — Clerk issues its own SSL
certificate against these, which doesn't work through Cloudflare's proxy.
Confirmed in Clerk's dashboard: Frontend API, Account portal, and Email all
show **Verified**, SSL Certificates show **Issued**.

**Vercel custom domain** (`trussen.app` + `www.trussen.app`) — added via
Vercel dashboard → project → Settings → Domains. This domain showed
"linked to another Vercel account" (from some earlier/unrelated setup),
requiring TXT ownership-claim records rather than a plain domain add:

| Record | Type | Target/Value |
|---|---|---|
| `@` | CNAME | `3c42362daa440744.vercel-dns-017.com` |
| `www` | CNAME | `3c42362daa440744.vercel-dns-017.com` |
| `_vercel` | TXT | `vc-domain-verify=trussen.app,33cdd20197f926e469c6` |
| `_vercel` | TXT | `vc-domain-verify=www.trussen.app,7e5767ff5468155f253c` |

**Important detail that cost real time getting wrong**: both TXT records
go at the **same name** (`_vercel.trussen.app`) — DNS allows multiple TXT
records at one name. The `www` verification value does **not** go at
`_vercel.www.trussen.app` despite that seeming more intuitive; Vercel's own
panel literally states the record location as `_vercel.trussen.app` for
both the root and `www` domain claims. (A leftover unused
`_vercel.www.trussen.app` TXT record was added during troubleshooting and
never removed — harmless, safe to delete during a later cleanup pass, not
urgent.)

All 4 set to **DNS only** (grey cloud) — Vercel's own edge/CDN handles
global distribution; Cloudflare proxying here would add nothing and
complicate cert issuance.

Confirmed in Vercel's dashboard: both `trussen.app` and `www.trussen.app`
show **Valid Configuration**.

---

## The DNS propagation gotcha (expected, not a bug)

After adding the Vercel records, `www.trussen.app` gave
`DNS_PROBE_FINISHED_NXDOMAIN` in a browser for a while, even after the
records were confirmed correct and resolving via public resolvers
(`1.1.1.1`, `8.8.8.8`) and even after flushing the local Mac's DNS cache
twice. Root cause: a **negative cache** — some DNS server between the
browser and the internet (most likely the router or ISP resolver, since
flushing the Mac's own cache didn't help) had cached "this domain doesn't
exist" from before the record existed, and negative answers get cached
just like positive ones, typically for minutes to a few hours.

Confirmed as exactly this by testing on a phone on a different network —
worked immediately there, while the Mac still failed. Same domain, same
DNS records, different cached state per network path.

**Nothing to fix here** — this resolves itself once the negative-cache TTL
expires. Ways to speed it up if it happens again on a future domain change:
flush the OS DNS cache (`sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`
on macOS), restart the router, or temporarily point the machine at
`1.1.1.1`/`8.8.8.8` directly in network settings to bypass the cached
answer entirely.

---

## What this does NOT mean

- **`api.trussen.app` is not set up yet** — that's a separate custom domain
  on the DO App Platform side, not covered by anything above. Still
  pending.
- **Env vars haven't been flipped** — `BASE_URL` (frontend), `FRONTEND_URL`/
  `BACKEND_URL` (backend) still point at the DO/Vercel default URLs, not
  the real domains. Flipping these and redeploying both sides is the next
  step, and should happen together with adding `api.trussen.app` (no point
  changing `BASE_URL` to an `api.trussen.app` that doesn't exist yet).
- **Login has not yet been tested successfully end to end** — DNS being
  correct is a prerequisite, not the same as having actually confirmed a
  real sign-in works on `https://trussen.app/login`. Do that once the env
  var flip + `api.trussen.app` are both done, not before.
- **The `trussen-theta.vercel.app` and per-branch preview URLs still exist
  and still work** — this is normal Vercel behavior, not something to
  clean up. They can't reach real user data even if found, since Clerk's
  Production instance rejects any origin except `trussen.app` and its
  subdomains — confirmed by this being the exact bug that motivated doing
  DNS now instead of later.

---

## What's next

1. Add `api.trussen.app` as a custom domain on the `trussen-backend` DO app
   (Settings → Domains) — DO will give a CNAME target to add in Cloudflare,
   this one **Proxied** (orange cloud), unlike everything else in this
   file.
2. Flip `BASE_URL` (frontend) to `https://api.trussen.app`, and
   `FRONTEND_URL`/`BACKEND_URL` (backend) to `https://trussen.app` /
   `https://api.trussen.app`. Redeploy both sides.
3. Test a real login at `https://trussen.app/login` — first time this can
   actually work, since it's the first time all three (Clerk's domain
   lock, the frontend, the backend) point at the same real domain
   simultaneously.
4. Separately, still pending from earlier: the BullMQ `drainDelay` tuning
   fix for Upstash's command usage (ai-worker was burning ~456k/500k
   monthly commands from idle polling alone within ~18 hours) — not
   related to DNS, just an open item from the same session.
