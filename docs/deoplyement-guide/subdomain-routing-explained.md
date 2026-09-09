# How company subdomains work (trussen.app vs fissiontech.trussen.app)

You're new to this, so this doc skips jargon and just walks through the idea
step by step, with one running example: a company called **Fission Tech**
signs up and gets `fissiontech.trussen.app`.

No code changes here — this is just "how it works" before we build it.

---

## 1. The goal in one sentence

Everyone shares the same app and the same server. The only thing that
changes per company is the **web address** they use, and a lookup that says
"this address belongs to this company."

Nothing is duplicated. There's one codebase, one database, one server. A
subdomain is just a label pointing at that same thing.

---

## 2. Step one: DNS — telling the internet "any subdomain goes here"

Normally, if you wanted `fissiontech.trussen.app` to work, you'd think you
need to go create a DNS record for it specifically. You don't.

You create **one** DNS record, a "wildcard":

```
*.trussen.app  →  your server
```

The `*` means "anything". So `fissiontech.trussen.app`, `acme.trussen.app`,
`literally-anything.trussen.app` — all of them already point at your server,
even before that company exists. You set this up once, ever. Signing up a
new company does **not** touch DNS.

Analogy: it's like telling the post office "any letter addressed to
`___.trussen.app` comes to my building" — instead of registering every
tenant's mailbox individually.

---

## 3. Step two: HTTPS — the padlock has to work for every subdomain too

Browsers want a valid certificate (the thing that gives you the padlock
icon) for whatever domain they're visiting. Since companies can have any
name, you get one **wildcard certificate** for `*.trussen.app`, and it
covers every subdomain automatically.

If you're hosting on something like Vercel, Cloudflare, or Render, this is
usually automatic once you add the wildcard domain. If you self-host, you'd
get a wildcard cert from Let's Encrypt. Either way — set up once, works for
every company forever.

---

## 4. Step three: the browser tells your app what subdomain it's on

Once someone visits `fissiontech.trussen.app`, your React app (running in
their browser) can literally just check the URL:

```js
window.location.hostname
// → "fissiontech.trussen.app"
```

Pull off the first part before `.trussen.app`:

```js
"fissiontech.trussen.app".split(".")[0]
// → "fissiontech"
```

That's it — that's the "which company is this" signal. If someone visits
plain `trussen.app` with no subdomain, there's nothing to split off, so you
know to show the marketing/landing page instead of a company's workspace.

```
trussen.app                      →  show landing page
fissiontech.trussen.app          →  this is company "fissiontech"
acme.trussen.app                 →  this is company "acme"
```

---

## 5. Step four: the backend turns that label into an actual company

The frontend now knows the label is `"fissiontech"`, but that's just text —
it means nothing until the server looks it up.

In this project, every company is stored as a `Workspace` row in the
database, and it already has a `slug` field for exactly this
(`prisma/schema.prisma`, the `Workspace` model) — e.g. `slug: "fissiontech"`.

So the frontend sends that label along with its API requests, and the
backend does the equivalent of:

```js
const company = await db.workspace.findUnique({ where: { slug: "fissiontech" } });
```

Now the server knows: "this request is for Fission Tech" — and every
database query for projects, tasks, members, etc. gets scoped to that one
company's data. Fission Tech never sees Acme's data and vice versa, because
every query is filtered by that company's ID under the hood.

---

## 6. Putting the whole flow together

Here's the full trip, start to finish, when someone opens
`fissiontech.trussen.app`:

```
1. Browser asks DNS: "where is fissiontech.trussen.app?"
2. DNS wildcard record answers: "same place as everything else — your server"
3. Browser connects, checks the padlock (wildcard cert covers it) — OK
4. Your React app loads and reads the address bar:
      "fissiontech.trussen.app" → label = "fissiontech"
5. React shows the workspace UI (not the landing page) and calls the API,
   including the label "fissiontech" with the request
6. The backend looks up: which company has slug "fissiontech"?
      → finds Fission Tech's Workspace row
7. The backend only returns Fission Tech's data
8. Fission Tech's team sees their own projects, nobody else's
```

If instead someone visits plain `trussen.app`, step 4 finds no label, so
step 5 shows the generic landing / sign-up page instead.

---

## 7. What happens at the exact moment a new company signs up?

This is the part people usually expect to be complicated. It isn't:

1. Company fills out a signup form, picks a name like "Fission Tech".
2. The app turns that into a slug: `fissiontech`. (Just text — lowercase,
   no spaces, must be unique — the database already enforces that:
   `slug String @unique`.)
3. A new `Workspace` row is created with that slug.
4. That's the whole "provisioning" step.

Nothing gets deployed, no server is spun up, no DNS record is added, no
certificate is requested. The wildcard DNS and wildcard certificate from
steps 2–3 already cover `fissiontech.trussen.app` — it started working the
moment the wildcard was set up, long before Fission Tech ever signed up.
Signup just decides what the label means, not whether the address exists.

---

## 8. Where this project currently stands

Worth knowing so expectations are calibrated: right now, the backend
figures out "which company" from a header/URL param
(`X-Workspace-Id` / `req.params.workspaceId`), **not** from the subdomain
yet. The `slug` field already exists and its comment in the schema even
says it's meant for `<slug>.trussen.app` — but nothing reads the subdomain
today.

So sections 1–3 (DNS + HTTPS) are pure infrastructure setup you'd do once,
and sections 4–5 (frontend reading the hostname, backend resolving slug →
workspace) are a small, focused piece of code that still needs to be
written. That's the next step whenever you're ready to build it.

---

## 9. What if someone visits a company subdomain that doesn't exist?

Example: nobody has ever signed up as "ghostcorp", but someone types
`ghostcorp.trussen.app` into their browser anyway.

Remember from step 2 — the wildcard DNS record means **every** subdomain
already reaches your server, real or not. There's no way to stop the
request from arriving. The "does this actually exist?" check has to happen
in your app, not in DNS.

So the flow is:

```
1. Browser reaches your server (wildcard DNS doesn't care if "ghostcorp" is real)
2. Frontend reads the label: "ghostcorp"
3. Frontend asks the backend "does a workspace with slug ghostcorp exist?"
4. Backend looks it up → nothing found
5. Frontend redirects the browser to the plain landing page (trussen.app)
```

This is the same lookup from section 5 — it just fails instead of
succeeding, and "lookup failed" is your signal to bounce them to the
landing page instead of showing a broken workspace.

---

## 10. First time visiting a real company subdomain: sign-in only, no sign-up

You want this rule: on `fissiontech.trussen.app`, a visitor can only sign
**in** — never sign **up**. Signing up for a brand-new company only happens
on the plain `trussen.app` landing page (that's the "create your company"
flow from section 7).

Why this matters: a company subdomain existing does not mean "anyone with
an email address can join it." It means "this company exists — now prove
you're allowed in," either by:
- already having an account that's a member of this workspace, or
- holding a valid invite link (section 11 covers who's allowed to be invited)

So the rule in plain terms:

```
trussen.app                 → shows landing page WITH sign-up
                               (this is where new companies are created)

fissiontech.trussen.app     → shows sign-in page ONLY
                               no "sign up" link or button anywhere
                               the only way in is: existing account, or an invite link
```

This isn't a security mechanism by itself (hiding a button doesn't stop
someone from calling the API directly) — it's a UX guardrail so people
don't accidentally try to "create an account" on a company's subdomain when
what they actually need is either an invite or the landing page. The real
gatekeeping is the invite/membership check on the backend, same as always.

---

## 11. Letting a company restrict invites to their own email domain

The idea: when Fission Tech invites people, they want to choose one of two
modes:

- **Restricted** — only `@fissiontech.com` emails can be invited at all
  (blocks a typo like inviting `bob@gmial.com`, or someone trying to invite
  an outside contractor by mistake)
- **Open** — invite any email address, any domain (useful for agencies,
  contractors, clients who don't have a `@fissiontech.com` address)

This is a per-company setting, so it lives on the `Workspace` itself —
something like:

```
Workspace {
  ...
  inviteDomainPolicy   "RESTRICTED" | "ANY"
  allowedEmailDomain   "fissiontech.com"   (only used when policy = RESTRICTED)
}
```

And the check happens at **invite-creation time**, not later:

```
Admin tries to invite "bob@othercompany.com" to Fission Tech
  → Fission Tech's policy is RESTRICTED, allowed domain is "fissiontech.com"
  → "othercompany.com" ≠ "fissiontech.com"
  → invite is rejected before it's even created — no email gets sent
```

This doesn't exist in the codebase yet — today, `createInvitation()`
(`modules/workspace/invitation.service.ts`) will happily invite any email
address. Adding this is a small, contained change: two new fields on
`Workspace`, one settings toggle in the UI, and one extra check at the top
of `createInvitation()`.

---

## 12. So what actually happens if the invite email and the sign-in email don't match?

Concretely: Fission Tech invites `someone@fissiontech.com`. That person
forwards the link (or just opens it in a browser signed into a different
account) as `someone@gmail.com`.

Good news — this part is **already built**, not something to add. When an
invite is accepted, the backend checks that the email of the person
accepting matches the email the invite was sent to, exactly
(`modules/workspace/invitation.service.ts`, the `acceptInvitationRecord`
function):

```
invited email:     someone@fissiontech.com
signed-in email:    someone@gmail.com
→ these don't match → reject with a clear message:
  "This invitation was sent to a different email address.
   Sign in with the invited email."
```

No membership is created, nothing leaks, nothing silently "just works" with
the wrong account. This check happens regardless of whether the company
uses Restricted or Open invite mode from section 11 — it's a separate
safety net that already exists today.

To put both checks together:

```
Section 11 (domain restriction) → runs when the invite is CREATED
                                    "are we even allowed to invite this address?"

Section 12 (email match)        → runs when the invite is ACCEPTED
                                    "is the person clicking this link
                                     actually the person it was sent to?"
```

Both need to pass. Section 11 is a policy choice per company (and still
needs building). Section 12 is a hard rule that always applies (and is
already live).
