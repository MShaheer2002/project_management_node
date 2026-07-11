# Phase 20E — MCP Server / AI Gateway Plan

## 1. Goal

Build a production-grade AI access layer for Trussen that lets external AI clients call workspace-scoped tools safely.

This must NOT become a second backend.

The MCP surface is only one protocol adapter over the backend that already exists:

- shared AI tool definitions
- shared deterministic tool executor
- existing workspace/role permission model
- existing Clerk identity model
- existing API key foundation
- existing activity and audit foundation

The correct production architecture is:

```txt
AI Clients
→ Trussen AI Gateway
→ identity resolution
→ permission engine
→ shared tool definitions
→ shared deterministic tool executor / services
→ Prisma / database
```

The gateway / MCP layer must not duplicate:

- business logic
- permission logic
- workspace isolation rules
- mutation behavior
- analytics computation

---

## 2. Product Outcome

After this phase, Trussen becomes:

- a normal PM app for humans
- an AI-operable PM platform for external agents
- a future-ready AI integration surface for Claude, ChatGPT, Codex, Cursor, and other clients

This means:

- Claude Desktop can inspect and manage workspace issues
- ChatGPT-compatible integrations can call safe Trussen tools
- Cursor/Codex can interact with workspace data through MCP
- internal bots can automate issue/project workflows using the same backend rules

The AI Gateway must eventually be strong enough for:

- high-quality analytics at every scope
- high-quality search
- high-quality creation and updating workflows
- high-quality member/user resolution through embeddings and semantic matching
- strict no-delete behavior across the entire exposed AI surface

The long-term product framing is:

> Trussen is the AI operating layer for project and work operations.

---

## 3. User Experience Goal

The goal is not “make the user understand MCP”.

The goal is:

> A Trussen owner or employee can connect a supported AI client in under one minute using a Trussen-generated connection method and no knowledge of Trussen internals.

That means:

- today, Trussen must generate copy-ready client config for generic MCP clients
- later, Trussen can support OAuth / discovery / one-click flows where clients allow it

The user should ideally only see:

- one AI connection token or one connect button
- one copy-config button for their chosen client
- one short setup checklist
- one clear connection test step

They should not have to know:

- workspace IDs
- internal route names
- permission internals
- custom headers unless the client requires them
- how the MCP executor works

---

## 4. AI Connections Platform

Phase 20E should evolve into an AI Connections Platform.

Recommended owner/user experience:

```txt
Settings
→ AI Connections
→ Generate Connection Method
→ Choose client (Codex / Claude Desktop / Cursor / Generic MCP / future OAuth clients)
→ Copy config or click Connect
→ Paste or authorize
→ Done
```

Supported connection methods should be modeled as:

1. `OAuth`
2. `Personal Access Token (PAT)`
3. `Service Account`

Do not tie auth type to a specific client.

Correct model:

- the client supports one or more auth modes
- the user scenario decides which auth mode should be used

Examples:

- ChatGPT may support OAuth first
- Claude Desktop may support PAT first and OAuth later
- Codex may use PAT today and OAuth later
- automation should use service accounts

For the owner-facing product:

- raw API keys remain a backend primitive
- AI Connections become the user-facing product surface

### 4.1 AI Connection Registry

AI Connections should become first-class product objects, not just generated config blobs.

Recommended product object:

```txt
AIConnection
- id
- workspaceId
- userId nullable
- serviceAccountId nullable
- client
- authType
- label
- status
- scopes
- lastUsedAt
- expiresAt
- createdAt
- updatedAt
```

This enables:

- per-client revocation
- per-client expiry
- connection auditability
- test-connection status
- future reconnect / rotate UX

---

## 5. Current Reality vs Future UX

### 5.1 Today

For generic MCP clients, Trussen provides:

- the connection token
- the MCP endpoint URL
- a ready-to-copy config block

The current product behavior should be:

- use `BACKEND_URL` when configured
- otherwise fall back to the local backend URL in development
- generate client configs that point directly at Trussen’s remote MCP endpoint

### 5.2 Future

For clients with native Trussen support, the user should only need:

- `Connect Trussen`
- login / authorize
- done

Desired production examples:

```toml
[mcp_servers.trussen]
url = "https://mcp.trussen.app"
auth_token = "trsk_live_xxxxxxxxx"
```

Or:

```txt
Connect Trussen
→ redirect to Trussen
→ login
→ authorize
→ done
```

The architecture must explicitly separate:

- protocol setup requirements
- final user experience

---

## 6. AI Gateway Requirement

Preferred topology:

```txt
Claude / Codex / Cursor / ChatGPT-compatible client
→ Trussen AI Gateway
→ authentication
→ identity resolution
→ workspace resolution
→ permission engine
→ planner / executor
→ Trussen tools and resources
```

The gateway layer should own:

- token validation
- token revocation
- rate limiting
- usage analytics
- connection auditing
- API/version evolution
- protocol-specific adapters
- OAuth entry points
- token scope enforcement
- client capability handling where relevant

This allows Trussen to harden external AI access without rewriting underlying business logic.

---

## 7. Identity Resolution Layer

Every authenticated request must be normalized into one actor context before any tool execution happens.

Recommended normalized shape:

```ts
type AiActorContext = {
  actorType: "USER" | "DELEGATED" | "SERVICE_ACCOUNT" | "AUTOMATION";
  actorId: string;
  workspaceId: string;
  client:
    | "chatgpt"
    | "chatgpt_enterprise"
    | "claude"
    | "claude_enterprise"
    | "claude_desktop"
    | "codex"
    | "cursor"
    | "generic_mcp"
    | "api";
  authMethod: "oauth" | "pat" | "service_account";
  scopes: string[];
  sessionId?: string | null;
};
```

Downstream layers should not care whether the request came from:

- ChatGPT
- Claude Enterprise
- Codex
- a delegated bot-like connection
- a service account

They should only care about the resolved actor and its scopes.

### 7.1 AI Session Model

AI interactions increasingly look like a workflow, not one isolated request.

Recommended shape:

```txt
AISession
- id
- workspaceId
- actorId
- actorType
- client
- authMethod
- connectionId nullable
- startedAt
- completedAt nullable
- status
- requestCount
- toolCallCount
- totalInputTokens nullable
- totalOutputTokens nullable
```

And session-linked tool events:

```txt
AISessionStep
- id
- sessionId
- toolName
- stepOrder
- status
- warnings
- startedAt
- completedAt
```

This gives Trussen:

- grouped audit trails
- better debugging
- better usage analytics
- clearer multi-step observability
- a foundation for future agent-style execution

---

## 8. Install vs Connect vs Authorize

Trussen must explicitly separate these 3 concepts:

1. `Install`
2. `Connect`
3. `Authorize`

Enterprise rule:

- installation can be organization-wide
- identity must remain personal unless intentionally using a delegated or bot identity

That means:

- an owner/admin may install Trussen once for a company
- each employee still authenticates as themselves when using Trussen through Claude or ChatGPT
- the employee does not inherit the owner’s permissions

---

## 9. Design Principles

### 9.1 Shared Tool Layer Only

MCP / AI Gateway must reuse shared AI tools and executor logic.

No separate protocol-only business logic.

### 9.2 Same Permission Boundary as App

The gateway must not bypass application permissions.

Every external AI call must execute with:

- `workspaceId`
- `actorId`
- `actorType`
- `scopes`
- `workspaceRole` where relevant

### 9.2.1 Policy Engine vs Permission Engine

Permission engine answers:

- can this actor read this issue?
- can this actor update this project?
- can this actor view workspace analytics?

Policy engine answers:

- is delete blocked globally?
- does this bulk action require approval?
- is this action too large to run in one step?
- is this tool disabled for this workspace?
- is this feature blocked by plan limits?
- is this action outside business-policy rules?

Recommended flow:

```txt
AI Client
→ AI Gateway
→ Identity Resolution
→ Policy Engine
→ Permission Engine
→ Business Service
```

### 9.3 Workspace Isolation is Mandatory

Every operation must remain workspace-scoped.

No cross-workspace visibility.
No global lookups without workspace filters.

### 9.4 No Destructive AI Surface

The gateway must respect the same AI safety policy:

- no delete issue
- no delete project
- no delete team
- no delete department
- no delete cycle
- no delete workspace
- no destructive billing changes

### 9.5 Thin Protocol Wrapper

The protocol layer should do only:

- authenticate session
- resolve actor identity
- bind tool/resource handlers
- normalize protocol input/output
- pass into shared executor
- format client-safe result payloads

### 9.6 Analytics Must Scale From Broad to Micro

The AI Gateway must be designed so analytics can operate at:

- workspace-wide
- department-wide
- team-wide
- project-wide
- sprint/cycle-wide
- individual member-wide

### 9.7 Search Must Be Strong

The exposed surface should eventually support:

- exact search
- fuzzy search
- semantic search
- cross-entity search where safe
- strong issue search
- strong project/team/member lookup

### 9.8 Creation and Updating Must Be Strong

The exposed AI surface must be optimized for:

- issue creation
- issue updating
- assignment
- comments
- project updates
- workflow/status changes

### 9.9 User/Member Resolution Must Be Strong

The system should support:

- aliases
- fuzzy matching
- semantic matching
- embeddings
- contextual team/department/project relationships

### 9.10 Approval / Confirmation for High-Impact Actions

High-impact operations must support explicit approval or confirmation workflows.

Examples:

- bulk issue reassignment
- bulk status change
- wide project/cycle updates
- membership changes where allowed

Expected behavior:

1. AI client requests a high-impact action
2. Trussen computes scope and affected resources
3. Trussen returns a preview
4. execution waits for confirmation
5. only then does the mutation happen

---

## 10. Existing Foundation Already Available

The backend already contains most of what this layer needs:

### 10.1 Shared AI Tools

- `modules/ai/tools/tool-definitions.ts`
- `modules/ai/tools/tool-executor.ts`

### 10.2 Auth Foundation

- API key creation/authentication
- Clerk-based user auth
- dual-auth middleware patterns
- user/workspace membership model

### 10.3 Safety and Permissions

- role checks
- workspace scoping
- private visibility filtering
- no-delete behavior in AI tool layer

### 10.4 Activity and Audit Foundation

- tool mutations already produce activity/audit records
- origin can be extended to capture MCP / AI Gateway source

Because of this, Phase 20E is mainly an integration layer, not a net-new backend domain.

---

## 11. Recommended Delivery Shape

Build this in 3 levels:

1. `V2 Scope`
2. `Must-Have For Production Beta`
3. `True GA / Production-Grade Backlog`

Important execution note:

- Trussen can complete most product, auth, policy, and operational behavior before the final hosted AI Gateway exists
- development can continue using `ngrok` for the remote MCP endpoint
- `ngrok` is acceptable for development and validation, but it is not itself the production hosting model

### 11.1 V2 Scope

This level is the current application-delivery target while Trussen still runs the remote MCP endpoint through `ngrok`.

It should cover:

- AI Connections as first-class objects
- PAT-based remote MCP access
- connection creation, revoke, rotate, verify, and health checks
- logical MCP session tracking and tool-call auditability
- client-specific setup instructions for Codex, Cursor, Claude Desktop, and generic MCP clients
- connection catalog and supported-auth-method discovery
- strict no-delete AI policy enforcement
- shared permission and policy execution through the existing backend
- connection status lifecycle: `active`, `revoked`, `expired`
- session status lifecycle: `active`, `succeeded`, `failed`, `rejected`
- stable MCP over HTTP for remote clients
- strong backend validation, typed schemas, and migration-backed persistence

V2 does NOT require final hosting or final OAuth provider rollout.

### 11.2 Must-Have For Production Beta

This level is the minimum acceptable scope before calling the AI Gateway production-beta ready.

It must cover:

- PAT connections with rotation, revocation, expiry, usage history, and production-safe secret handling
- OAuth connection architecture implemented end-to-end at the application layer
- access-aware response rules for `401`, `403`, and `404`
- connection scopes with deny-by-default execution checks
- delegated identity support for user-owned delegated connections and service accounts
- stable tool exposure rules with execution-time permission enforcement
- connection/session/tool-call observability
- security event logging for failed auth, revoked token usage, unusual usage patterns, and repeated refresh failures
- rate limiting and AI-specific quotas at the gateway layer
- plan-aware feature/policy controls
- operational runbooks for migrations, rollback, and token incident response

Production beta can still run on `ngrok` for development or internal validation, but that is not the final external production posture.

### 11.3 True GA / Production-Grade Backlog

This level closes the gap from production beta to full GA.

It should cover:

- final hosted MCP gateway domain and load-balanced deployment
- secret-manager-backed production secrets
- high availability and horizontal scaling
- backup and disaster recovery for AI connections, sessions, audit, and token metadata
- full OAuth discovery documents and provider metadata on the production domain
- enterprise SSO extensions such as OIDC/SAML/SCIM where product strategy requires them
- advanced anomaly detection such as impossible-travel and client-fingerprint risk scoring
- API versioning, deprecation policy, and compatibility guarantees
- formal penetration testing and abuse-path validation
- cross-region or multi-instance deployment strategy if Trussen scale requires it

GA is where the platform becomes operationally production-grade, not just application-feature complete.

---

## 12. Production-Beta Contract

If this cycle is described as “must cover everything” at the product/application level, that should mean:

- the auth model is complete
- the permission and policy model is complete
- the connection lifecycle is complete
- the audit and observability model is complete
- the security response contract is complete
- the system is deployable later behind a production host without redesigning the application layer

In other words:

- application architecture should be production-complete in this cycle
- final infrastructure cutover can remain future work

What may remain after this cycle:

- replacing `ngrok` with the final production host/domain
- production secret-store wiring
- HA/load-balancer rollout
- enterprise identity-provider onboarding
- formal security/compliance rollout tasks

What should NOT remain:

- undefined access behavior
- missing scope model
- missing OAuth lifecycle design
- unclear token lifecycle rules
- unclear actor/delegation model
- ambiguous session/accounting semantics

---

## 13. Access-Aware Response Contract

This must be explicit because it is a security boundary, not only an API detail.

Recommended rules:

- `401 Unauthorized`
  - no valid auth token
  - expired or malformed token
  - failed OAuth bearer validation
- `403 Forbidden`
  - actor is authenticated
  - actor may know the resource exists
  - actor lacks permission for the requested action
  - action is blocked by policy even if the resource is visible
- `404 Not Found`
  - resource truly does not exist
  - or Trussen intentionally hides existence because exposing it would leak sensitive information

Examples:

- authenticated user cannot edit a visible project
  - return `403`
- authenticated user requests a private issue they should not know exists
  - return `404`
- AI action is blocked by no-delete or business policy
  - return `403` with a policy-specific error code

Recommended implementation rule:

- resource existence disclosure must be decided intentionally per resource type
- private-resource lookups must support hide-existence behavior
- the gateway must never leak existence accidentally through inconsistent codes

---

## 14. Tool Exposure vs Tool Execution

The default production recommendation is:

- keep the exposed tool catalog stable for most business tools
- enforce permissions and scopes at execution time

This improves AI planning because the client can reason over a consistent capability surface.

Default rule:

- Owner sees `update_issue`
- Member sees `update_issue`
- Guest sees `update_issue`
- execution result differs based on permissions, scopes, and policy

Exception rule:

- truly sensitive or administrative tools may be hidden entirely from lower-trust actors

Trussen should model:

- tool visibility
- tool executability
- tool policy availability

as separate concepts, even if most tools use stable visibility plus execution-time checks.

---

## 15. Connection Scopes

Production beta must support scope-aware AI connections.

Recommended examples:

- `issues.read`
- `issues.write`
- `projects.read`
- `projects.write`
- `comments.write`
- `analytics.read`
- `members.read`
- `documents.read`
- `documents.write`
- `admin.ai_connections`

Scope rules:

- scopes narrow permissions; they never expand them beyond the actor’s real Trussen permissions
- effective access is the intersection of:
  - actor permissions
  - workspace membership
  - connection scopes
  - product policy
- missing scope should fail closed
- scopes must be auditable on every connection and every tool execution

Examples:

- workspace owner with a read-only PAT cannot execute write tools
- service account with `issues.write` but no `analytics.read` cannot access analytics tools

---

## 16. Delegated Identity and Service Accounts

Production architecture should not treat every AI connection as the full user.

Trussen should support:

1. `USER`
2. `DELEGATED`
3. `SERVICE_ACCOUNT`
4. `AUTOMATION`

Recommended delegated behavior:

- an owner can create a connection for a bot-like workflow
- that connection inherits only approved scopes
- it does not act as unrestricted owner access

Service-account requirements:

- workspace ownership is explicit
- naming rules are enforced
- disable/revoke behavior is clear
- deletion of the parent workspace removes or disables the service account predictably
- audit trails identify the service account separately from the human creator

---

## 17. OAuth Architecture

OAuth should be covered in this plan as an implementation target, not left vague.

### 17.1 What This Cycle Should Cover

At the application layer, this cycle should cover:

- OAuth connection model
- OAuth connection lifecycle
- OAuth identity mapping into Trussen actors
- OAuth session persistence
- refresh/reconnect/revoke handling
- per-client OAuth connection records
- audit and observability for OAuth events
- support for multiple client connections per user

### 17.2 OAuth Lifecycle

Recommended lifecycle:

1. client starts connect flow
2. Trussen redirects to auth provider
3. Trussen receives callback
4. Trussen maps external identity to Trussen identity
5. Trussen stores connection/session metadata securely
6. Trussen issues or records usable session credentials
7. Trussen refreshes when allowed
8. Trussen marks connection `needs_refresh`, `expired`, `revoked`, or `invalid_credentials` as needed

### 17.3 OAuth Connection States

Recommended states:

- `connected`
- `needs_refresh`
- `expired`
- `revoked`
- `disabled`
- `invalid_credentials`

### 17.4 Install vs Connect

For enterprise behavior:

- install can be organization-wide
- connect remains per user or per delegated/service identity

### 17.5 Multi-Workspace Behavior

The plan should explicitly support:

- actor identity mapped once
- workspace membership resolved per request
- workspace selection validated per action/session

No OAuth flow should bypass workspace membership checks.

### 17.6 Provider Extensibility

The architecture should not block:

- Trussen-native OAuth
- OpenAI/ChatGPT-compatible OAuth patterns
- Google
- Microsoft Entra ID
- Okta
- enterprise OIDC/SAML extensions later

Important boundary:

- full app-layer OAuth support should be implemented in this cycle
- final hosted discovery endpoints and provider-domain hardening can remain part of the production-host rollout

---

## 18. PAT and Token Lifecycle

PAT support should behave like a real production system.

Recommended requirements:

- token is shown only once
- raw token is never recoverable after creation
- token secret is hashed or otherwise stored with production-safe handling
- token metadata is auditable
- token can expire
- rotation creates a new usable token and invalidates or rejects old active usage appropriately
- revocation is immediate
- usage history captures at least last used time, recent sessions, and tool activity

Recommended metadata:

- label
- owner
- delegated/service-account binding if present
- scopes
- client type
- created at
- last used at
- expires at
- rotated at
- revoked at
- created by

Recommended policy decisions:

- maximum token count per actor or workspace
- default expiry behavior
- whether no-expiry is restricted by plan or admin policy

---

## 19. Session and Usage Accounting

Session accounting must be precise enough for audit, support, and billing.

Recommended rules:

- one logical AI conversation/workflow should map to one logical session where the client exposes a reusable session identifier
- repeated MCP HTTP requests inside that same conversation should not create fake extra sessions
- two simultaneous conversations from the same client should count as two sessions
- one session can contain many MCP requests and many tool calls

Trussen should track at least:

- connection count
- logical session count
- raw request count
- tool call count
- per-session status and timestamps

This distinction is important for:

- debugging
- customer support
- pricing/quotas
- anomaly detection
- product analytics

---

## 20. Resource-Level Permission Coverage

The plan should allow resource-aware authorization for:

- workspace
- project
- issue
- comment
- document
- attachment
- member
- analytics view
- custom field
- cycle/sprint
- team/department

This means the architecture must support resource-level checks without later redesign.

---

## 21. AI-Specific Quotas and Limits

AI usage limits belong at the gateway/policy layer, not inside tool implementations.

Examples:

- tool calls per day
- sessions per hour
- write actions per minute
- analytics-heavy queries per window
- connection count per workspace

These limits should support:

- workspace plan limits
- actor-type-specific limits
- abuse prevention
- graceful error codes and retry guidance

---

## 22. Security and Anomaly Detection

Production-beta readiness should include baseline security-event support.

Recommended events:

- invalid token usage
- revoked token reuse
- repeated failed OAuth refresh
- access from unusual country or client fingerprint
- suspicious rapid token failures
- scope violation attempts
- policy-blocked destructive attempts

Recommended response capabilities:

- log and surface events
- optionally disable or challenge risky connections
- support later step-up auth or manual review flows

Advanced impossible-travel and stronger device fingerprinting may remain GA/enterprise hardening, but the event model should be designed now.

---

## 23. Operational Readiness

Hosting is not the only remaining production concern.

Before calling the system truly production-grade, Trussen also needs:

- secret management
- migration deployment strategy
- rollback strategy
- backup and restore plan
- HA/load-balancer plan
- monitoring and alerting
- API versioning/deprecation policy
- incident response for token compromise
- security testing for replay, abuse, privilege escalation, and injection paths

This document should treat those as required operational work, even if some of them are completed during the later hosting rollout.

---

## 24. Environment Variables and External Keys

### 24.1 Needed Now

For the current development/internal validation cycle, the system should only require the existing backend/application variables plus MCP endpoint configuration, such as:

- `DATABASE_URL`
- `PORT`
- `NODE_ENV`
- `FRONTEND_URL`
- `BACKEND_URL`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `RESEND_FROM_ADDRESS`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_STANDARD_MONTHLY_PRICE_ID`
- `STRIPE_PREMIUM_MONTHLY_PRICE_ID`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN` if temporary AWS credentials are used
- `AWS_REGION`
- `AWS_S3_BUCKET`
- `AWS_S3_URL_TTL_SECONDS`
- `AWS_S3_UPLOAD_PREFIX`
- `AWS_S3_PUBLIC_BASE_URL` if public asset URLs are used
- `UPLOAD_IMAGE_MAX_BYTES`
- `UPLOAD_VIDEO_MAX_BYTES`
- `OPENROUTER_API_KEY` if AI features are enabled
- `AI_ISSUE_MODEL_DEFAULT`
- `AI_ISSUE_MODEL_FALLBACK_1`
- `AI_ISSUE_MODEL_FALLBACK_2`
- `AI_ISSUE_MODEL_FALLBACK_3`
- `AI_CHAT_MODEL_DEFAULT`
- `AI_CHAT_MODEL_FALLBACK_1`
- `AI_CHAT_MODEL_FALLBACK_2`
- `AI_CHAT_MODEL_FALLBACK_3`
- `AI_ENFORCE_BILLING`
- `AI_FREE_DAILY_REQUEST_LIMIT`
- `AI_STANDARD_DAILY_REQUEST_LIMIT`
- `AI_PREMIUM_DAILY_REQUEST_LIMIT`
- `AI_FREE_DAILY_TOKEN_LIMIT`
- `AI_STANDARD_DAILY_TOKEN_LIMIT`
- `AI_PREMIUM_DAILY_TOKEN_LIMIT`
- `REDIS_URL` if background AI infrastructure is enabled
- `REDIS_QUEUE_PREFIX`
- `AI_BACKGROUND_WORKERS_ENABLED`
- `AI_BACKGROUND_SCHEDULER_ENABLED`
- `AI_EMBEDDING_MODEL`
- `AI_STALE_ISSUE_DAYS`
- `AI_BACKGROUND_ASSIGNEE_CANDIDATE_LIMIT`
- `TRUSSEN_MCP_SERVER_NAME`
- `TRUSSEN_MCP_SERVER_VERSION`

If `ngrok` remains the remote endpoint for now, you also need:

- the `ngrok` public base URL used in generated client config
- `BACKEND_URL` set to that public base URL so generated MCP config is correct

Important:

- `TRUSSEN_MCP_API_KEY` or `MCP_API_KEY` is only needed for local stdio / legacy MCP startup flows
- the remote production-style HTTP MCP path now authenticates with Trussen AI connection tokens, not a single shared server token

### 24.2 Needed When OAuth Is Implemented

Application-layer OAuth implementation will typically need provider-specific variables, such as:

- `ENCRYPTION_KEY` for encrypted token storage
- one or more OAuth client IDs
- one or more OAuth client secrets
- OAuth redirect URI base or per-provider callback URLs
- OAuth issuer / authorization / token endpoint settings if not fully discovered
- optional OAuth scopes/audience defaults where provider integration requires explicit configuration

Exact names should be defined when the provider implementation lands, but expect at least:

- `ENCRYPTION_KEY`
- one client ID
- one client secret
- one callback base URL
- one encryption/secret key strategy for stored OAuth credentials

If Trussen implements its own first-class MCP OAuth provider endpoints, production rollout will also require final callback and issuer values to match the production public domain exactly.

### 24.3 Needed Later For Final Production Hosting

When switching from `ngrok` to the final production host, expect additional infrastructure configuration:

- final public MCP base URL
- final OAuth callback URLs
- production secret-manager wiring
- production TLS/domain configuration
- load balancer / gateway routing config
- monitoring/alerting integrations
- any reverse-proxy or gateway trusted-origin configuration if introduced during hosting hardening

### 24.4 What May Be Needed From Your Side

Potential inputs from the product owner/admin side:

- final decision on OAuth provider(s) to support first
- final production domain for MCP hosting
- any enterprise SSO roadmap decisions
- quota/plan policy decisions
- token expiry defaults and security policy preferences
- whether delegated connections and service accounts should be exposed in UI immediately or backend-first

If those decisions are not finalized yet, the architecture can still be implemented now with sensible defaults and extension points.

### 24.5 Current Gap Between `.env.example` and Production-Grade Runtime

The current backend runtime schema expects some variables that are not fully represented in `project_management_node/.env.example`.

To bring the template up to production-documentation quality, `.env.example` should explicitly include at least:

- `BACKEND_URL`
- `RESEND_FROM_ADDRESS`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_STANDARD_MONTHLY_PRICE_ID`
- `STRIPE_PREMIUM_MONTHLY_PRICE_ID`
- `AI_ENFORCE_BILLING`
- `AI_FREE_DAILY_REQUEST_LIMIT`
- `AI_STANDARD_DAILY_REQUEST_LIMIT`
- `AI_PREMIUM_DAILY_REQUEST_LIMIT`
- `AI_FREE_DAILY_TOKEN_LIMIT`
- `AI_STANDARD_DAILY_TOKEN_LIMIT`
- `AI_PREMIUM_DAILY_TOKEN_LIMIT`
- `TRUSSEN_MCP_API_KEY`
- `MCP_API_KEY`
- `TRUSSEN_MCP_SERVER_NAME`
- `TRUSSEN_MCP_SERVER_VERSION`

The backend also currently references `SLACK_BOT_TOKEN` in `.env.example`, but the main env schema does not validate it. That mismatch should be resolved separately so the template and schema stay authoritative.
