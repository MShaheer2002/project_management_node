# MCP Connections — Current State & Production OAuth Review

> **This is a review and design report only — no code was changed.** Requested
> explicitly as "review only, generate a report," not an implementation pass.
> Every claim below about the current codebase is grounded in specific files
> read directly; every claim about the MCP Authorization spec is grounded in
> the actual SDK package already installed in this repo (`@modelcontextprotocol/sdk@^1.29.0`),
> not general knowledge — I read its type definitions directly rather than
> recalling them.

---

## 1. What you have right now — real, and more solid than it might look

Your MCP integration is not a toy. It's a genuine Streamable HTTP MCP server with real session tracking. What it's missing is one specific thing: OAuth. Here's the actual inventory.

### 1.1 The MCP server itself

- `mcp/server.ts` / `mcp/mcp.server-factory.ts` — builds an `McpServer` (from the official SDK) per session, registers tools (`mcp.tools.ts`) and resources (`mcp.resources.ts`) scoped to that session's workspace/user
- `mcp/mcp.http.routes.ts` — mounted at `/mcp` (`app/app.ts:184`), using the SDK's `StreamableHTTPServerTransport` — this is the **current, correct transport**, not the deprecated SSE-only one. One thing worth knowing: it's configured stateless (`sessionIdGenerator: undefined`), so every request gets a fresh `McpServer`/transport pair rather than a persisted MCP session — fine for how it's used today, worth remembering when adding OAuth doesn't accidentally assume server-side session state exists.

### 1.2 Authentication today — a real, working PAT system, not OAuth

`mcp/mcp.auth.ts` — every request is authenticated by extracting a Bearer token (or `?api_key=`/`?token=` query param — `extractMcpAccessToken`) and validating it against your existing `ApiKey` table (`authenticateWithApiKey`, shared with your regular workspace API keys). This is matched to an `AiConnection` record, which is where the client-specific bookkeeping lives:

```
AiConnection: workspaceId, userId, apiKeyId, label, client (enum), status, scopes, usage counters
```

`AiConnectionClient` enum (`prisma/schema.prisma:305`) currently recognizes `CODEX`, `CLAUDE_DESKTOP`, `CURSOR`, `GENERIC_MCP`.

**This is the "authenticate the app" pattern you described as option 2 — and it's already built, not a gap.** `ai-connection.service.ts` even has per-client config generators already:

```
buildClaudeDesktopConfig(token)   buildCodexConfig(token)
buildCursorConfig(token)          buildGenericSetup(token)
```

These produce the JSON snippet a user copies into `claude_desktop_config.json` (or equivalent) with a token pre-filled — the manual "paste your key" flow.

### 1.3 Session observability — genuinely thorough, worth calling out

`AiConnectionSession` (`prisma/schema.prisma`) tracks, per connection, per logical session: request count, tool-call count, last error code/message, transport (`http`/`stdio`), and a `providerSessionId`/`sessionKey` correlation mechanism (`mcp.auth.ts:197`, `extractMcpLogicalSessionHint`) that stitches together stateless HTTP requests from clients like ChatGPT that don't maintain a persistent connection, using `_meta["openai/session"]` from the MCP request body. This is a level of operational detail many MCP server implementations skip entirely. Not a gap — noting it because it's good and should be preserved by whatever gets built next.

### 1.4 What's missing — precisely, not vaguely

There is **no OAuth authorization server** anywhere in this codebase. No `/authorize`, no `/token`, no `/register`, no `/.well-known/oauth-*` metadata endpoints, no consent screen, no PKCE, no Dynamic Client Registration. `mcp.auth.ts` only ever validates a token that already exists — it has no way to issue one interactively. This is the entire gap between where you are and "click a link, authorize, done."

### 1.5 Important finding: this is already anticipated in the code, not a new idea

`modules/ai-connection/ai-connection.catalog.ts` already has a full `AiConnectionRequestedAuthType = "pat" | "oauth"` type, a `PLATFORM_AUTH_METHODS` catalog listing OAuth as `status: "planned", implemented: false`, and — this is the concrete part — an explicit guard function that's already wired into the live `POST /ai-connections` endpoint:

```ts
// ai-connection.catalog.ts:110
export function assertAiConnectionAuthMethodSupported(client, authType) {
  ...
  if (authType === "oauth") {
    throw new AppError(
      501,
      ERROR_CODES.AI_CONNECTION_AUTH_NOT_IMPLEMENTED,
      "OAuth AI connections are planned but not available in this version.",
    );
  }
```

There's even a requirements list already sitting in the catalog data, written before this review:

```
"OAuth client registration, redirect URIs, and consent flow design."
"Per-user identity binding so each employee acts as themselves."
```

Every `CLIENT_CAPABILITIES` entry (`codex`, `claude_desktop`, `cursor`, `generic_mcp`) already has an `availableAuthMethods` array and a `supportsOAuth: false` flag sitting right next to `supportsPAT: true` — waiting to be flipped once the provider exists.

**Why this matters for the report's conclusion:** building OAuth here isn't introducing a new concept into the codebase — it's finishing a path the schema and API contract already committed to (`aiConnectionAuthTypeSchema` in `ai-connection.schemas.ts` already accepts `"oauth"` as a request body value, it's rejected at the service layer, not the validation layer). The `Prisma` `AiConnectionAuthType` enum is the one place still lagging — it only has `PAT` today and would need an `OAUTH` value added.

---

## 2. What "option 1" (the link) actually is — grounded in the real spec, not folklore

The link Claude/Codex show you isn't a special integration — it's the standard outcome of a client discovering that your server supports OAuth 2.1 with a specific extension. Three RFCs, in the order a client actually walks through them:

| RFC | What it does | Where it'd live |
|---|---|---|
| **RFC 9728** — Protected Resource Metadata | Your MCP endpoint responds to an unauthenticated request with `401` + a `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource`. This tells the client *which* authorization server to talk to. | New — doesn't exist today |
| **RFC 8414** — Authorization Server Metadata | `/.well-known/oauth-authorization-server` advertises your `/authorize`, `/token`, `/register`, `/revoke` endpoint URLs and supported grant types. | New — doesn't exist today |
| **RFC 7591** — Dynamic Client Registration | The actual "no manual app setup" mechanism. Claude, ChatGPT, Codex, Cursor — any compliant client — register themselves as an OAuth client automatically on first connect. **This is what makes it work for "other desktop and web clients" too, not just Claude** — DCR is the generic standard, not a per-vendor integration. Implement it once, correctly, and every MCP-compliant client gets the same experience. | New — doesn't exist today |

Underneath these, it's standard OAuth 2.1 authorization-code-with-PKCE — the same flow as "Sign in with Google," just where your app is the authorization server instead of Google.

### 2.1 The genuinely good news: you don't have to build the RFC plumbing

I read the actual package already sitting in `node_modules` — `@modelcontextprotocol/sdk` ships a **complete, ready-to-mount OAuth authorization server**. Specifically (verified by reading the `.d.ts` files directly, not recalled):

- **`mcpAuthRouter(options)`** (`server/auth/router.d.ts`) — one function call that wires up all five endpoints: both metadata endpoints, `/register`, `/authorize`, `/token`, `/revoke`. Comes with rate limiting by default.
- **`OAuthServerProvider`** (`server/auth/provider.d.ts`) — the one interface you implement. Six methods: `authorize()`, `challengeForAuthorizationCode()`, `exchangeAuthorizationCode()`, `exchangeRefreshToken()`, `verifyAccessToken()`, `revokeToken()`. This is where Trussen-specific logic goes — everything else is provided.
- **`OAuthRegisteredClientsStore`** (`server/auth/clients.d.ts`) — a two-method interface (`getClient`, `registerClient`) backing Dynamic Client Registration. `registerClient` being unimplemented is explicitly how you'd opt *out* of DCR if you ever wanted to — but supporting it is the entire point here.
- **`ProxyOAuthServerProvider`** (`server/auth/providers/proxyProvider.d.ts`) — an alternative pre-built provider that proxies `/authorize` and `/token` to an *upstream* OAuth server instead of implementing the flow yourself. Only relevant if Clerk (your existing auth provider) exposes a spec-compliant OAuth authorization-server surface suitable for this — **not yet confirmed**, and typically the more standard pattern for products in your position (existing session system, want workspace-scoped consent) is a thin custom `OAuthServerProvider` that sits in front of your own session/workspace model, which is what Atlassian's, Notion's, and Figma's MCP connectors do. Worth a spike to check Clerk's capabilities before ruling it out, but plan around the custom-provider path as the default.

So the actual work is not "implement OAuth" — it's "implement six methods that connect the SDK's OAuth machinery to Trussen's existing Clerk session and `AiConnection`/`ApiKey` tables."

---

## 3. Recommended architecture

The core idea: **OAuth becomes a new front door to the exact same `AiConnection`/`ApiKey` infrastructure that already exists** — not a parallel system. When someone completes the consent flow, the token exchange creates the same kind of `AiConnection` + `ApiKey` row that `createAiConnection()` (`ai-connection.service.ts:645`) already creates for the manual flow today. Revocation, usage counters, session tracking — all of it keeps working unchanged, because the thing being issued is still fundamentally an `AiConnection`.

```
Claude/Codex/etc. → GET /mcp (no token)
                  → 401 + WWW-Authenticate → /.well-known/oauth-protected-resource
                  → discovers /.well-known/oauth-authorization-server
                  → POST /register  (Dynamic Client Registration — automatic, no human involved)
                  → browser opens → GET /authorize
                  → [Trussen consent screen: "Claude wants to connect to <workspace> — Allow/Deny"]
                  → user already has a Clerk session (or logs in via Clerk first)
                  → approve → redirect back to client with an authorization code
                  → client → POST /token  (exchanges code for access + refresh token, PKCE-verified)
                  → the token exchange is the moment an AiConnection + ApiKey row is created,
                    exactly like the manual "generate a token" flow does today
                  → client uses the access token as the MCP Bearer token, same as now
```

### 3.1 What's net-new

1. **The `OAuthServerProvider` implementation** — the real work. `authorize()` renders/redirects to a consent page; on approval, mints an authorization code; `exchangeAuthorizationCode()` verifies PKCE and creates the `AiConnection`/`ApiKey` pair; `verifyAccessToken()` becomes the new front door that `mcp.auth.ts` calls instead of (or alongside) today's raw API-key check; `revokeToken()` maps onto the existing `revokeAiConnection()`.
2. **A `OAuthRegisteredClientsStore`** — a new, small table for dynamically-registered clients (client_id, redirect URIs, etc.) — this doesn't exist in the schema yet.
3. **A consent screen** — one new frontend page, outside this backend repo's scope. Needs: workspace picker (see §4), the requesting client's name, Allow/Deny.
4. **Mounting `mcpAuthRouter()`** at the app root (per its own doc comment, it must be mounted at root, not under `/mcp`) plus updating `mcp.http.routes.ts`'s 401 response to carry the `WWW-Authenticate` header pointing at the new metadata endpoint.

### 3.2 What stays exactly as-is

- `AiConnection` / `ApiKey` schema and services — reused, not replaced
- `AiConnectionSession` tracking — unaffected, since it keys off `apiKeyId`, which OAuth-issued connections still have
- The manual per-client config builders (`buildClaudeDesktopConfig` etc.) — still valid for any client that doesn't do OAuth, or for CI/scripted use where a static long-lived token is actually the right tool
- `mcp.tools.ts` / `mcp.resources.ts` / the tool-execution path — completely unaffected; OAuth only changes *how a token gets issued*, not what a validated session can do

---

## 4. Decision already made

**Workspace selection on the consent screen: an explicit picker**, not an implicit "current workspace" default. Confirmed — for a user in multiple workspaces, the consent screen shows which workspace this connection will be scoped to, matching how the existing manual-token flow already implies per-connection scoping (`createAiConnection` takes an explicit `workspaceId`).

## 5. Decision deferred — flagged, not resolved

**Should the manual token flow stay available once OAuth exists, or should OAuth replace it?** Not decided yet — you asked for a report, not a build, so this wasn't pushed to a conclusion. My recommendation, stated plainly so it's easy to accept or override: **keep both.** OAuth covers the clients that support it (Claude.ai web, current desktop clients); the manual flow remains the right tool for anything that doesn't speak OAuth yet, and for CI/scripted access where a non-interactive static key is a feature, not a workaround. Nothing about building the OAuth path requires removing the manual one — they'd share the same underlying `AiConnection` records either way.

---

## 6. Honest scope and risk assessment

This is a real feature, not a quick add:

- **It's security-critical code.** You're building an authorization server that issues credentials into real workspace data. PKCE validation, redirect URI validation, authorization-code single-use enforcement, and token expiry/refresh all have to be correct — these are exactly the kind of details that are invisible when working and catastrophic when wrong. This should get a dedicated security review pass before shipping, separate from ordinary code review.
- **It's a multi-part change**, not a single file: new Prisma models (registered clients, authorization codes in flight), the provider implementation, route mounting, a new frontend consent page (outside this repo), and updates to `mcp.auth.ts` to accept OAuth-issued tokens alongside the existing raw API-key path.
- **The SDK does the RFC-compliance heavy lifting**, which meaningfully de-risks this — you're not hand-rolling PKCE or metadata discovery, you're implementing business logic behind a well-typed interface the SDK already validates requests against.
- **Testing against real clients matters more than usual here.** Claude Desktop, Claude.ai web, and Codex each have their own OAuth client implementation quirks in practice even when spec-compliant; plan to actually test the flow end-to-end with at least two real clients before calling it done, not just unit-test the provider in isolation.

---

## 7. How to test what's already implemented, end to end

This is the PAT flow (§1.2) — it's real and live right now, so it's testable right now, without waiting on any OAuth work. Everything below hits real endpoints already mounted in `app.ts`.

### 7.1 Create a connection (this is the "web" step)

`POST /ai-connections` — requires a normal authenticated Trussen session (Clerk) with `ADMIN` or `OWNER` role in the workspace (`ai-connection.routes.ts:51-59`). This is the closest thing to "connecting from the web" that exists today — there's no dedicated OAuth consent page, but this endpoint is what any such web UI would call under the hood, and per §1.5 the API contract is already shaped to add `authType: "oauth"` later without breaking this call.

```bash
curl -X POST "$BASE_URL/ai-connections" \
  -H "Authorization: Bearer <your Clerk session token>" \
  -H "Content-Type: application/json" \
  -H "X-Workspace-Id: <workspace id>" \
  -d '{"name": "Test Claude Desktop Connection", "primaryClient": "claude_desktop"}'
```

The response (`createAiConnection`, `ai-connection.service.ts:645`) is the whole point of this step — save it, the raw token is shown exactly once:

```json
{
  "connection": { "id": "...", "label": "Test Claude Desktop Connection", "client": "CLAUDE_DESKTOP", "status": "ACTIVE", ... },
  "token": "<raw API key — this is the only time it's ever returned in plaintext>",
  "primaryClient": "claude_desktop",
  "setup": {
    "claudeDesktop": { "format": "json", "config": "{...ready-to-paste claude_desktop_config.json snippet...}" },
    "codex": { "format": "toml", "config": "..." },
    "cursor": { "format": "json", "config": "..." },
    "genericMcp": { "format": "guide", "endpoint": "...", "authHeaderValue": "Bearer ..." }
  }
}
```

### 7.2 Verify the token actually works against the live MCP server

You don't need a real Claude Desktop install to test this — the MCP endpoint speaks plain JSON-RPC over HTTP, so `curl` is a legitimate MCP client for testing purposes. Three calls prove the whole chain:

```bash
TOKEN="<token from 7.1>"
MCP_URL="$BASE_URL/mcp"

# 1. Initialize — confirms auth succeeds and the server identifies itself
curl -s -X POST "$MCP_URL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-test","version":"1.0"}}}'

# 2. List tools — confirms the session is correctly scoped and tools registered
curl -s -X POST "$MCP_URL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3. Call a real, read-only tool — confirms workspace scoping end-to-end, not just auth
curl -s -X POST "$MCP_URL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}'
```

Step 3 should return real projects from the workspace the connection was created in — if it returns projects from a *different* workspace, or an empty/error result when the workspace genuinely has projects, that's a scoping bug worth chasing immediately, not a testing artifact.

**A built-in verification path already exists and is worth using instead of hand-rolling the above every time**: `GET /ai-connections/:id/health` (`getAiConnectionHealth`, `ai-connection.service.ts:583`) runs a live connectivity check and returns `diagnostics.verificationPrompt: "List my Trussen projects"` — literally a pre-written prompt meant to be pasted into the connected AI client to confirm the connection works from the client's own side, not just via direct API calls.

```bash
curl -s "$BASE_URL/ai-connections/<connection id>/health" \
  -H "Authorization: Bearer <Clerk session token>" -H "X-Workspace-Id: <workspace id>"
```

### 7.3 Test the parts most people forget to test

- **Session tracking** — `GET /ai-connections/:id/sessions` should show the `initialize`/`tools/list`/`tools/call` traffic from §7.2 as tracked activity (`AiConnectionSession`, request/tool-call counters). If this is empty after real MCP traffic, session correlation is broken, not just unpopulated.
- **Rotation** — `POST /ai-connections/:id/rotate` should invalidate the old token immediately (re-run §7.2's step 1 with the old token — it must now fail) and return a new one that works.
- **Revocation** — `DELETE /ai-connections/:id`, then re-run §7.2's step 1. It must return `401` with `AI_CONNECTION_REVOKED` (`mcp.auth.ts:53-59`), not a generic auth failure — the specific error code is what a real client would use to tell "revoked" apart from "never valid."
- **A real client, at least once** — direct `curl` proves the API contract, but the actual `claude_desktop_config.json` produced by §7.1's `setup.claudeDesktop` field should be pasted into a real Claude Desktop install and exercised at least once before calling any of this "tested." Config-shape bugs (a wrong key name, a missing `type: "http"`) are invisible to a curl-based test that talks JSON-RPC directly and skips the config file entirely.

---

## 8. Why OAuth is worth building — tied to concrete gaps in what §7 just tested

Every point here is a limitation of the flow you can go test right now, not a hypothetical:

- **It doesn't work for Claude.ai web at all, structurally — not "not yet configured."** The desktop-config approach in §7.1 works because there's a local file to paste JSON into. Claude.ai's web-based custom connectors have no such file — the *only* way to connect a web client is a browser redirect to an authorization endpoint. This isn't a gap OAuth closes incrementally; it's the one thing that makes the web case possible at all.
- **The token is a shared secret that has to travel through a human, in plaintext, at least once.** §7.1's response shows the raw token exactly once, by design — but getting it from that API response into `claude_desktop_config.json` means it passes through a clipboard, possibly a chat message to whoever's doing the setup, possibly a screenshot for a support ticket. Every one of those is a leak surface that doesn't exist in the OAuth flow, where the token never leaves the browser-to-server exchange.
- **Revocation today is coarse — you're right about it, but with lower blast radius than it sounds.** §7.3 shows revocation *works*, but it's connection-level: revoke it and every client using that token stops working at once, indiscriminately. That's already true today and doesn't get worse with OAuth — but OAuth's per-client Dynamic Client Registration (§2) means each *client* gets its own credential from the same authorization, so revoking "the Claude Desktop connection I set up on my old laptop" doesn't require also breaking "the Claude Desktop connection on my current one," which today it would, since both share one manually-copied token unless someone remembered to create two separate connections.
- **Setup friction compounds per person, per client.** Today, onboarding one person onto one client is: log into Trussen web → find the connections page → click create → copy a token → open a config file → paste → save → restart the client. That's a support-ticket-shaped amount of steps, multiplied by every employee and every client they use. The OAuth flow collapses this to: click "Connect" in the client, approve in a browser tab you're likely already logged into. This is less a security upgrade than a support-load reduction — it's the difference between explaining copy-paste steps repeatedly and the client handling it invisibly.
- **This isn't speculative scope-creep — §1.5 shows it was already the intended next step.** The catalog code's own `"OAuth AI connections are planned but not available in this version"` message means the case for building this was already made, by whoever wrote that line, before this review existed.

---

## 9. The `client` field (`codex`/`claude_desktop`/`cursor`/`generic_mcp`) is cosmetic, not functional — verified

Checked whether `client` causes the MCP server to behave any differently per client. It doesn't. Every `CLIENT_CAPABILITIES` entry (`ai-connection.catalog.ts`) has `supportsStreaming`, `supportsResources`, `supportsPrompts`, `supportsSampling`, and `supportsNotifications` all hardcoded `false`, and none of those flags are read anywhere outside the catalog's own display data. `session.client` (`mcp.auth.ts`) flows into logging and session-tracking metadata (`mcp.tools.ts:369,402`) and nothing else — no branch in `mcp.server-factory.ts`, `mcp.tools.ts`, or `mcp.http.routes.ts` treats one client differently from another.

**What `client` actually does today: pick which config-file template to render.** `buildCodexConfig()` returns TOML, `buildClaudeDesktopConfig()`/`buildCursorConfig()` return JSON — same MCP server, same auth, same tools, just a different snippet syntax so the config paste-in works for that specific app. `generic_mcp` already is the "any valid MCP client" case the report's original question was asking about — it's not missing, it's already there, just framed as one option among four instead of the default framing.

**Recommendation:** don't remove the client picker — it's genuinely useful for generating the right config syntax and for "which clients are people actually using" analytics — but the UI and any documentation should present this as **one MCP connection, with an optional "which app are you setting this up for" hint**, not as four different kinds of connection. That's a framing/copy fix, not an architecture change; nothing here needs to be rebuilt.

---

## 10. One token type — merging `ApiKey` and `AiConnection` into a single Personal Access Token

### 10.1 The problem, confirmed at the code level, not assumed

`createAiConnection()` (`ai-connection.service.ts:645`) calls `createApiKey()` internally — an AI Connection *is* an `ApiKey` row, plus an `AiConnection` row wrapping it. Two separate user-facing features (`/api-keys` and `/ai-connections`) both ultimately write to the same `ApiKey` table, using the same function. That's not a coincidence to design around — it's confirmation the split is artificial.

The split isn't just confusing, it's a real gap:

- A plain key from `/api-keys` **cannot** authenticate to MCP — `toSessionContext()` (`mcp.auth.ts`) throws `AI_CONNECTION_NOT_FOUND` if the key has no linked `AiConnection`. So "API Keys" and "AI Connections" aren't interchangeable today, even though they're the same underlying primitive.
- The reverse isn't true. An AI-Connection-backed key **also** works as a plain REST credential — `authenticate-api-key.ts` only checks the `ApiKey` table, it has no idea `AiConnection.scopes` exists. So a token someone sets up as "read-only for my AI assistant" is, right now, a fully-privileged key if pointed at `POST /issues` directly instead of `/mcp`. Any scope enforcement that only lives in the MCP tool-call path (§11) is bypassable this way — it isn't hardened, it's cosmetic, unless it's enforced at both layers.

### 10.2 Recommended fix: one token type, one flow

Collapse this into a single Personal Access Token concept:

- **`AiConnection` becomes the canonical model** (it already has the richer bookkeeping — sessions, health checks, verification) — `ApiKey` stays exactly what it already functionally is: the underlying secret storage, not a separate user-facing feature. The standalone `/api-keys` create flow goes away in favor of one creation flow.
- **`scopes` becomes the real authorization surface** for every token, checked at whichever layer the token is used against — not just MCP. §11 already designs the taxonomy; this section is about making it apply everywhere a token can be used, not just one code path.
- **`client` stops gating anything** and becomes what §9 already found it functionally is today — an optional label that picks a config-snippet template, nothing more. A token isn't "a Claude Desktop token" or "a Cursor token," it's a token someone happens to be pasting into Claude Desktop or Cursor right now.

This is the same model GitHub, Figma, and Atlassian all converged on independently: one PAT type, scoped, usable anywhere the holder chooses to put it.

### 10.3 Enforcement has to span two layers now, not one

| Layer | Where | Status today | What's needed |
|---|---|---|---|
| MCP tool calls | `mcp.tools.ts` | Not enforced — `session.scopes` is read but never checked (§11.1) | `hasScope()` check per tool (§11.3/§11.4) |
| General REST API | `authenticate-api-key.ts` (called from the dual-auth middleware) | Not enforced at all — resolves user/role from the key and stops there | A route → scope map, same `hasScope()` check, run once the key is resolved |

This is the honest cost of unifying, worth stating plainly: scoping only the 28 MCP tools is a contained job; scoping the general REST API means every route a token could hit needs a scope tag. It's not a bigger design problem — §11.2's taxonomy already mirrors the REST resource groups (issues, projects, teams, departments, cycles, members, analytics), so it's mostly "attach the existing scope name to the existing route," not new taxonomy work — but it is more surface area to touch than MCP alone, and skipping it means the unification doesn't actually close the gap in §10.1, it just relocates it.

### 10.4 Migration — don't silently break what already works

Existing rows predate scopes meaning anything, so backfill everything to `scopes: ["admin"]` on ship day — that's a no-op relative to today's actual behavior (nothing is restricted today), not a new grant. Anyone who wants a tighter connection edits it afterward. The alternative — defaulting existing tokens to no scopes — would silently break every live integration the moment enforcement goes live.

### 10.5 What this needs, concretely

1. Retire the standalone `/api-keys` creation UI/flow in favor of `/ai-connections` as the single entry point (backend `ApiKey` model/table is unaffected — it's still the storage layer underneath).
2. `scopes` becomes real per §11.4 (points 1–3 there already cover the storage and MCP-side check).
3. Add the same `hasScope()` check to `authenticate-api-key.ts` (or immediately after it resolves the key, in the dual-auth middleware), gated by a route → scope map.
4. Backfill existing `ApiKey`/`AiConnection` rows to `scopes: ["admin"]` (§10.4).
5. Independent of OAuth (§3) — OAuth just becomes a third way to mint one of these same unified, scoped tokens, not a parallel system to reconcile later.

---

## 11. Access scopes — read/write permissions per connection

### 11.1 What exists today: storage with no enforcement

`AiConnection.scopes` (`Json?` column) exists, but every connection gets the same hardcoded value and nothing ever checks it:

```ts
// ai-connection.service.ts:23
const AI_CONNECTION_SCOPES = ["mcp:v1"];
```

Confirmed by grep: `scopes` is only ever read to populate this same constant, and to log into `logAiInfo`/`logAiError` metadata (`mcp.tools.ts:369,402`) for observability. **No code path checks a connection's scopes before executing a tool.** Right now, any authenticated connection can call all 28 MCP tools — read and write — with no gate.

**The building block for real enforcement already exists, half-wired.** Every tool in `mcp/mcp.tools.ts` already carries a `readOnly?: boolean` flag — currently used only to set the MCP `readOnlyHint: true` advisory annotation (a hint to the *client* about which tools are safe to auto-approve, not a server-side permission check). The information needed to gate tools by read/write is already sitting on every tool definition; it's just never consulted for authorization.

### 11.2 Proposed scope taxonomy — modeled directly on Figma's PAT scope UI

Reference: Figma's own "Generate new token" dialog groups scopes by resource category, each with its own `:read`/`:write` checkbox and a one-line plain-language description (screenshots reviewed directly, not recalled). Same shape, mapped onto Trussen's actual 28 MCP tools — not a generic guess:

| Category | Scope | Description | Gates |
|---|---|---|---|
| Issues | `issues:read` | View issues, comments, and search | `list_issues`, `get_issue`, `search_issues` |
| | `issues:write` | Create, edit, assign, comment on issues | `create_issue`, `update_issue`, `update_issue_status`, `assign_issue`, `add_comment` |
| Projects | `projects:read` | View projects and summaries | `list_projects`, `get_project_summary` |
| | `projects:write` | Create and edit projects | `create_project`, `update_project` |
| Teams | `teams:read` | View teams and workload | `list_teams`, `get_team_workload` |
| | `teams:write` | Create and edit teams | `create_team`, `update_team` |
| Departments | `departments:read` | View departments | `list_departments` |
| | `departments:write` | Create and edit departments | `create_department`, `update_department` |
| Cycles | `cycles:read` | View cycles/sprints | `list_cycles` |
| | `cycles:write` | Create and edit cycles | `create_cycle`, `update_cycle` |
| Members | `members:read` | View workspace members | `list_members` |
| Analytics | `analytics:read` | View all analytics (workspace/project/team/member/cycle) | all 5 `get_*_analytics` tools |

Members and Analytics have no `:write` pair because there is currently no mutating tool in either domain — not an omission, just what exists today.

### 11.3 Admin — a real bypass scope, not a UI shortcut that expands to a list

Two ways to implement an "Admin / full access" option: (a) purely client-side — checking it just ticks and submits every scope above, or (b) a genuine `admin` scope value the backend treats as a wildcard. **(b) is the recommended design**, for a concrete forward-compatibility reason: under (a), the day a new tool is added — e.g. a future `delete_issue` or `invite_member` — every existing "admin" connection silently stops covering it until someone manually re-ticks a box for a scope that didn't exist when they set the connection up. Under (b), a new tool just needs a scope tag and every `admin`-scoped connection covers it automatically, the same way a wildcard IAM policy does.

**Enforcement** — one short-circuit ahead of the per-tool check, not a parallel system:

```ts
function hasScope(session: McpSessionContext, required: string): boolean {
  return session.scopes.includes("admin") || session.scopes.includes(required);
}
```

**UI behavior for the "Admin — full access" toggle**, specified precisely since this is the exact behavior requested:

- Sits above the categorized checkbox list as its own row, visually distinct from the category groups (a toggle, not a list item)
- **Checking it**: every category checkbox below visually shows checked and becomes `disabled` — visible confirmation of what admin implies, not editable while active
- **Unchecking it**: checkboxes re-enable and **revert to whatever was individually selected before Admin was checked**, not reset to blank — requires the UI to retain granular selection in local state even while the checkboxes are disabled, so toggling Admin on and back off doesn't destroy prior choices
- **What's actually submitted to `POST /ai-connections`**: if Admin is checked, the request sends `scopes: ["admin"]` only — not the fully expanded list — so newly-added tools are automatically covered without the connection needing to be edited again. The granular checkboxes while Admin is active are a *preview* of what it grants, not literal submitted values.

### 11.4 What this needs, concretely

1. `AiConnection.scopes` starts storing real values (`["issues:read", "projects:write"]`, or `["admin"]`) instead of the placeholder `["mcp:v1"]` — no schema migration needed, the column is already a flexible `Json?`
2. Each tool spec in `mcp.tools.ts` gets a `scope` field alongside its existing `readOnly` flag (e.g. `scope: "issues:write"`) — additive, doesn't touch any of the 28 tools' actual handler logic
3. One `hasScope()` check (§11.3) added to the tool-call path before a handler runs, returning a clear permission-denied error — not a generic 401 — when it fails
4. The frontend checkbox grid (separate repo, not reviewed directly — paste it in if a literal review is wanted) sends the scope array shape defined in §11.2/§11.3 on connection creation; Figma's screenshots are a usable visual reference for the component itself: category headers, checkbox + monospace scope name + description per row, plus the Admin master-toggle described above

---

## 12. If you want to move forward

Natural next step, when you're ready, is a spike on §2.1's open question — whether Clerk can act as the upstream for `ProxyOAuthServerProvider` — since that materially changes how much of §3.1 item 1 is custom code versus configuration. After that, the phased build is: schema (registered clients + in-flight auth codes) → provider implementation → route mounting → consent page → end-to-end test against a real client, in that order, since each step is meaningfully unblockable-and-testable on its own before the next.

Independently of the OAuth work, §10 (unifying tokens) and §11 (scope enforcement) are their own small, self-contained change — no new schema, one tool-spec field, one route→scope map, one check function reused in two places — and don't need to wait on anything else in this report to be built.
