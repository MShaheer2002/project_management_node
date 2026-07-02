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

The product expectation is not just “basic MCP support”. The AI Gateway must eventually be strong enough for:

- high-quality analytics at every scope
- high-quality search
- high-quality creation and updating workflows
- high-quality member/user resolution through embeddings and semantic matching
- strict no-delete behavior across the entire exposed AI surface

This is strategically valuable because it turns Trussen from “an app with an AI panel” into “a system AI can operate through a typed protocol”.

The long-term product framing is:

> Trussen is the AI operating layer for project and work operations.

---

## 3. User Experience Goal

The product goal is not “make the user understand MCP”.

The product goal is:

> A Trussen owner or employee can connect a supported AI client in under one minute using a Trussen-generated connection method and no knowledge of Trussen internals.

This is a user-experience requirement, not a transport guarantee.

Generic MCP clients still need to know where the Trussen MCP server lives, because they do not have built-in knowledge of Trussen.

That means:

- today, Trussen must generate copy-ready client config for generic MCP clients
- later, Trussen can support OAuth / discovery / one-click flows where clients allow it

The user should ideally only see:

- one AI connection token or one connect button
- one “copy config” button for their chosen client
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

This sits above raw API keys and MCP details.

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

Wrong model:

- ChatGPT = OAuth
- Codex = PAT

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

This enables a much cleaner product experience:

```txt
Settings
→ AI Connections
→ Connected Clients
   - Codex (active)
   - Claude Desktop (expired)
   - Cursor (active)
   - ChatGPT (connected)
```

It also enables:

- per-client revocation
- per-client expiry
- connection auditability
- “test connection” status
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

That means the user should not have to run a local MCP process manually just to connect Codex, Claude Desktop, or Cursor.

### 5.2 Future

For clients with native Trussen support, the user should only need:

- `Connect Trussen`
- login / authorize
- done

This is how GitHub, Slack, and Google integrations feel when the client already knows the provider.

The desired production example is:

```toml
[mcp_servers.trussen]
url = "https://mcp.trussen.app"
auth_token = "trsk_live_xxxxxxxxx"
```

Or for clients with OAuth:

```txt
Connect Trussen
→ redirect to Trussen
→ login
→ authorize
→ done
```

So the architecture must explicitly separate:

- protocol setup requirements
- final user experience

---

## 6. AI Gateway Requirement

The long-term production architecture should not expose raw internal MCP mechanics directly.

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
  actorType: "USER" | "SERVICE_ACCOUNT" | "AUTOMATION";
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

This is critical because downstream layers should not care whether the request came from:

- ChatGPT
- Claude Enterprise
- Codex
- a bot
- a service account

They should only care about the resolved actor and its scopes.

### 7.1 AI Session Model

Over time, Trussen AI interactions will stop being “one request, one tool call”.

They will increasingly look like:

1. resolve project
2. search issues
3. read issue details
4. update issue
5. add comment
6. return summary

That is one AI workflow, not 5 unrelated actions.

So the platform should support an `AISession` model.

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
- promptCount
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
   - makes Trussen available inside an organization or client
2. `Connect`
   - identifies the actual Trussen user or bot
3. `Authorize`
   - decides what that actor can read or mutate

This is the key enterprise rule:

- installation can be organization-wide
- identity must remain personal unless intentionally using a bot or service account

That means:

- an owner/admin may install Trussen once for a company
- each employee still authenticates as themselves when using Trussen through Claude or ChatGPT
- the employee does not inherit the owner’s permissions

---

## 9. Design Principles

### 9.1 Shared Tool Layer Only

MCP / AI Gateway must reuse:

- `modules/ai/tools/tool-definitions.ts`
- `modules/ai/tools/tool-executor.ts`

No separate protocol-only business logic.

### 9.2 Same Permission Boundary as App

The gateway must not bypass application permissions.

Every external AI call must execute with:

- `workspaceId`
- `actorId`
- `actorType`
- `scopes`
- `workspaceRole` where relevant

And the result must be exactly what that actor could do in the UI or through approved automation.

Authorization must always belong to the shared permission engine and business services.

### 9.2.1 Policy Engine vs Permission Engine

The platform should explicitly separate `permission` from `policy`.

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

This keeps concerns clean:

- RBAC stays in permissions
- operational product rules stay in policy

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
- no delete member or membership through destructive delete semantics
- no delete workspace
- no destructive billing changes
- no destructive credential destruction unless explicitly allowed for a service account lifecycle action

Blocked actions should remain blocked at the shared executor / policy layer.

### 9.5 Thin Protocol Wrapper

The protocol layer should do only:

- authenticate session
- resolve actor identity
- bind tool/resource handlers
- normalize protocol input/output
- pass into shared executor
- format client-safe result payloads

Nothing more.

### 9.6 Analytics Must Scale From Broad to Micro

The AI Gateway must be designed so analytics can operate at all meaningful scopes:

- workspace-wide
- department-wide
- team-wide
- project-wide
- sprint/cycle-wide
- individual employee/member-wide

### 9.7 Search Must Be Strong

Search quality is a first-class requirement.

The exposed surface should eventually support:

- exact search
- fuzzy search
- semantic search
- cross-entity search where safe
- strong issue search
- strong project/team/member lookup

### 9.8 Creation and Updating Must Be Strong

The exposed AI surface must be optimized for the highest-value write operations:

- issue creation
- issue updating
- assignment
- comments
- project updates
- workflow/status changes
- safe team/project/cycle CRUD allowed by policy

### 9.9 User/Member Resolution Must Be Strong

Member resolution is a major product requirement.

The system should support strong member understanding using:

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

This keeps delivery realistic while preserving the long-term architecture.

---

## 12. V2 Scope

### 12.1 Objective

Deliver the next real AI Connections platform slice that:

- keeps the current MCP surface working
- hardens the PAT-based connection flow
- improves client usability and connection setup
- formalizes auth modes and client capabilities
- establishes the production-ready platform shape before final hosting cutover

V2 should be treated as:

- product architecture complete enough for serious development use
- not yet final production hosting
- the foundation for production beta

### 12.2 Development Transport Strategy

During V2, remote MCP can continue using:

- `ngrok`-exposed backend/MCP endpoints

This is acceptable for now because the current goal is:

- complete the connection model
- complete auth and policy behavior
- complete client setup UX
- validate external AI client behavior end-to-end

Do NOT confuse this with final production hosting.

The V2 rule is:

- implement the system as if it were production-grade
- keep the transport endpoint on `ngrok` during development
- defer the hosting cutover until the app/platform layer is ready

### 12.3 V2 Functional Scope

V2 should include:

- AI connection registry improvements
  - explicit client
  - explicit auth method
  - label
  - status
  - expiry
  - revoke
  - last used
  - test connection
- client capability modeling
  - `supportsPAT`
  - `supportsOAuth`
  - setup mode expectations
  - remote/local connection assumptions where relevant
- hardened PAT lifecycle
  - create
  - list
  - revoke
  - expiry handling
  - ownership visibility
- setup UX improvements
  - exact client-specific steps
  - copy config
  - connection verification
  - troubleshooting guidance
- auth-mode groundwork
  - PAT fully usable and hardened
  - OAuth modeled in domain/API/UI even if not fully implemented yet
- stronger AI connection auditing and usage recording
- consistent client-safe error handling
- no-delete policy preserved across all external AI clients

### 12.4 V2 Transport Expectations

V2 should support:

- `stdio` where useful for local clients
- remote HTTP MCP through the current development tunnel

Important:

- V2 should not require the final hosted gateway to validate the product model
- V2 should keep the same shared execution layer for local and remote paths

### 12.5 V2 Tool and Resource Expectations

V2 should continue using the safe shared executor surface and should not fork protocol-specific business logic.

At minimum, the existing safe MCP tool set should remain working and attributable:

- `list_issues`
- `get_issue`
- `create_issue`
- `update_issue_status`
- `assign_issue`
- `add_comment`
- `list_projects`
- `list_cycles`
- `list_members`
- `search_issues`

V2 should also preserve read-only resource behavior where already exposed.

### 12.6 V2 Module Expectations

The platform should continue to center around:

```txt
mcp/
├── server.ts
├── mcp.http.routes.ts
├── mcp.auth.ts
├── mcp.server-factory.ts
├── mcp.tools.ts
├── mcp.resources.ts
└── types.ts
```

And the AI Connections product layer should evolve around:

- connection registry
- auth-mode modeling
- capability registry
- connection setup UX
- connection verification
- usage and audit hooks

### 12.7 V2 Done Criteria

V2 is done when:

- MCP server boots successfully
- auth resolves actor + workspace context
- remote MCP works through the current `ngrok` endpoint
- Codex, Cursor, Claude Desktop, and Generic MCP can connect through the supported PAT flow
- client-specific setup guidance is good enough for a normal user to follow
- AI connections have explicit client/auth/status/lifecycle metadata
- PAT flows return clear errors for revoked, expired, invalid, or unsupported states
- OAuth is represented as a planned auth mode without pretending it is fully live
- blocked operations remain blocked
- workspace scoping is preserved
- audit trails remain attributable to the authenticated actor

---

## 13. Must-Have For Production Beta

### 13.1 Beta Objective

Production beta means:

- the product behavior is strong enough for serious external use
- the auth, identity, policy, and lifecycle layers are reliable
- the main remaining gap is final hosting and infrastructure hardening

This is the minimum bar before Trussen should market the AI gateway as a serious external integration surface.

### 13.2 Auth and Identity Requirements

Production beta must have:

- PAT lifecycle complete
  - create
  - list
  - revoke
  - expiry
  - clear creator ownership
- actor normalization for every AI request
  - user
  - workspace
  - client
  - auth method
  - scopes
- capability registry enforced server-side
- no silent permission escalation through client context

If OAuth is started during beta, it must follow the correct rule:

- each human user acts as themselves
- no shared owner connection may silently represent all employees

### 13.3 Policy and Safety Requirements

Production beta must have:

- read/write policy separation
- tool allowlist / mutation safety enforcement
- no-delete boundary preserved across all supported clients
- token scope enforcement
- rate limiting / abuse controls
- clear blocked-action behavior and auditability

### 13.4 Connection Lifecycle Requirements

Production beta must have:

- connection create/list/revoke flows
- status and expiry visibility
- last-used tracking
- connection test flow
- setup/troubleshooting flow for supported clients
- strong error handling for:
  - invalid token
  - expired token
  - revoked token
  - unsupported client/auth combination
  - permission denied
  - blocked by policy

### 13.5 Observability and Audit Requirements

Production beta must have:

- per-connection usage visibility
- auth failure visibility
- blocked-action visibility
- actor/client/auth attribution for requests
- connection auditability for support and security review

Recommended observability metrics:

- tool call volume
- top tools used
- failure rate
- auth failure rate
- blocked action rate
- actor type distribution
- client distribution
- per-connection usage
- per-policy-block rate

### 13.6 Beta Runbook

Production beta must document:

- how to generate a connection token / PAT
- how to connect Codex
- how to connect Claude Desktop
- how to connect Cursor
- how to connect a generic MCP client
- how to verify a connection
- how to troubleshoot auth and tool failures
- how to revoke a broken or leaked connection

### 13.7 Beta Hosting Reality

During development and validation, `ngrok` is acceptable.

But the production beta standard should assume:

- the product logic is production-structured
- the transport will later move to a real hosted gateway

So beta should avoid coupling core product behavior to `ngrok` specifics.

---

## 14. True GA / Production-Grade Backlog

### 14.1 Multiple Auth Modes

Support:

1. OAuth for human users
2. Personal access tokens
3. Service accounts
4. internal Clerk-backed sessions where relevant

### 14.2 Transport Expansion

After V2 and beta logic are stable, support final hosted remote transports where needed:

- streamable HTTP
- remote MCP
- future gateway protocol variants

### 14.2.1 Hosting Cutover From ngrok To Production Host

The switch from development tunneling to the real hosted AI Gateway should be treated as an infrastructure cutover, not a product redesign.

Before cutover, development may continue using:

- `ngrok`
- `BACKEND_URL`
- current remote MCP endpoint generation

At cutover time, Trussen should replace the temporary tunnel with:

- a stable production host
- stable TLS
- production DNS and routing
- production secrets/config management
- production monitoring and alerting

What should change at cutover:

- endpoint base URL
- deployment topology
- operational controls
- production security hardening

What should NOT need redesign at cutover:

- AI connection registry
- actor normalization
- auth-mode modeling
- capability registry
- PAT lifecycle
- OAuth domain model
- policy enforcement
- audit and usage contracts
- client setup product model

The goal is:

- complete product and platform behavior first
- swap the transport host later with minimal application-layer changes

Long-term the AI Gateway may expose:

- MCP
- REST for AI-style tool integrations
- OAuth endpoints
- webhooks
- SSE/streaming where needed

### 14.3 Expanded Tool Surface

Expose more safe tools from the shared executor:

- project summary/status tools
- member workload tools
- team analytics tools
- cycle analytics tools
- department analytics tools
- workspace analytics tools
- individual member analytics/report tools
- document read/write tools where safe

### 14.4 Analytics Surface

Production analytics should support:

- workspace-wide analytics
- department-wide analytics
- team-wide analytics
- project-wide analytics
- sprint/cycle-wide analytics
- individual employee/member analytics

### 14.5 Search Surface

Production search should support:

- issues
- projects
- teams
- departments
- members
- cycles
- comments
- documents where safe

Backed by:

- deterministic filters
- fuzzy ranking
- embedding-assisted retrieval where appropriate

### 14.6 Create / Update Surface

Production-grade AI access should be strongest in:

- creation
- updates
- assignment
- commenting
- prioritization
- scheduling

### 14.7 Plan and Permission Gating

The gateway must respect:

- workspace role permissions
- product plan/feature gates
- AI safety restrictions
- token scopes
- actor type restrictions

It should also support workspace-level feature flags for AI capabilities.

Examples:

- disable issue creation through AI
- disable project mutations through AI
- allow analytics but block mutations
- allow only read tools for a restricted workspace

These are policy-layer controls, not replacements for RBAC.

### 14.8 Session and Identity Safety

Production-grade AI access should:

- validate auth at startup when session-based
- validate auth per request when protocol requires it
- refuse invalid or expired credentials
- keep actor identity explicit
- never silently upgrade user permissions because of client context

For OAuth-based enterprise flows:

- org install and user connect must stay separate concepts
- company-wide installation must not turn every employee into the owner
- each human user must act as themselves unless the integration is intentionally bot-based

### 14.9 Read / Write Policy Separation

Keep clean internal allowlists:

- read tools
- safe mutation tools
- blocked tools

This should be driven by a capability registry, not scattered hardcoded checks.

Recommended capability metadata:

```txt
ToolCapability
- name
- description
- requiredScopes
- readOrWrite
- confirmationRequired
- aiSafe
- experimental
- policyCategory
```

This lets the platform reason about tools consistently across:

- MCP
- REST AI endpoints
- future protocols

### 14.10 Service Accounts

Service accounts are an enterprise feature and should be strictly scoped.

Examples:

- `Analytics Bot`
- `Release Bot`
- `Planning Bot`

Rules:

- never default to unlimited access
- always use explicit scopes
- always support revoke/rotate
- always audit as bot identity

### 14.11 Personal Access Tokens

Users should be able to create multiple PATs for different environments.

Examples:

- `MacBook Codex`
- `Cursor on Work Laptop`
- `GitHub Action`
- `Local MCP Testing`

Every PAT should support:

- label
- createdAt
- expiresAt
- lastUsedAt
- scopes
- revoke
- rotate

### 14.12 OAuth Architecture

Production-grade remote AI integrations should support OAuth-based user connections where the client supports it.

Recommended behavior:

1. an org/admin installs Trussen in the AI client or approves it for the company
2. the client makes Trussen available to employees
3. each employee connects their own Trussen account once
4. Trussen issues user-bound access
5. every request runs as that real employee

Wrong behavior:

- owner connects once
- every employee silently uses owner permissions

That is not acceptable.

### 14.13 No-Delete Policy

The AI Gateway must preserve the same no-delete stance across all external AI surfaces.

Blocked operations include:

- delete workspace
- delete project
- delete issue
- delete team
- delete department
- delete cycle
- destructive billing changes

If a client asks for these:

- the gateway must refuse
- the executor must refuse
- audit should record the blocked attempt

### 14.14 Client Capability Model

Do not assume every client supports the same protocol features.

Instead of only storing client name, the platform should model client capabilities such as:

- supportsOAuth
- supportsPAT
- supportsStreaming
- supportsResources
- supportsPrompts
- supportsSampling
- supportsNotifications

This avoids coupling behavior to assumptions like:

- “all Claude clients behave the same”
- “all MCP clients support the same config shape”

It also gives Trussen a cleaner path to support future AI clients without redesign.

---

## 15. Production Architecture Summary

```txt
AI Clients
────────────────────────────────────────
ChatGPT
ChatGPT Enterprise
Claude
Claude Enterprise
Claude Desktop
Codex
Cursor
VS Code AI tools
Future MCP clients
────────────────────────────────────────
                │
                ▼
          Trussen AI Gateway
────────────────────────────────────────
MCP
REST
OAuth
PAT
Service Accounts
Rate Limits
Tool Registry
Audit
Observability
Protocol Adapters
────────────────────────────────────────
                │
                ▼
          AI Connection Registry
────────────────────────────────────────
Connected Clients
PAT-backed Connections
OAuth-backed Connections
Service Account Links
Status / Expiry / Last Used
────────────────────────────────────────
                │
                ▼
         Identity Resolution Layer
────────────────────────────────────────
Human User
Service Account
Automation
Workspace
Client
Auth Method
Scopes
────────────────────────────────────────
                │
                ▼
             Policy Engine
────────────────────────────────────────
No Delete
Approval Rules
Bulk Limits
Plan Limits
Workspace Feature Flags
Operational Constraints
────────────────────────────────────────
                │
                ▼
          Permission Engine
────────────────────────────────────────
Workspace RBAC
Project Scope
Team Scope
Department Scope
Policy Rules
Approval Rules
Plan Gating
────────────────────────────────────────
                │
                ▼
          Shared Business Services
────────────────────────────────────────
Issues
Projects
Teams
Departments
Cycles
Members
Analytics
Search
Comments
Documents
────────────────────────────────────────
                │
                ▼
              Database
```

This architecture should also support session-level execution and audit:

```txt
AI Session
→ multiple tool calls
→ one grouped audit trail
→ one observability unit
```

---

## 16. Plain-English Flows

This section explains how each integration should work in simple English.

### 16.1 Codex Flow

Best for:

- developers
- power users
- local terminal workflows

Flow:

1. user goes to Trussen `AI Connections` or `PATs`
2. user creates a personal token
3. Trussen shows ready-to-copy Codex config
4. user pastes config into Codex
5. Codex connects to Trussen
6. every request runs as that exact Trussen user
7. permissions are enforced based on that user’s real role

Simple rule:

- Codex is connected as the person who created the token

### 16.2 Claude Desktop Flow

Best for:

- individual users
- local MCP workflows

Flow:

1. user creates a Trussen token or PAT
2. Trussen shows Claude Desktop config
3. user pastes config into Claude Desktop
4. Claude Desktop connects to Trussen
5. every request runs as that Trussen user

Simple rule:

- Claude Desktop sees what that connected user is allowed to see

### 16.3 Cursor Flow

Best for:

- developers
- IDE workflows

Flow:

1. user creates a Trussen token
2. user pastes Cursor config from Trussen
3. Cursor connects to Trussen
4. the user asks for tasks, creates issues, updates work, or reads analytics
5. Trussen enforces the same permissions the user has in the Trussen app

### 16.4 Generic MCP Client Flow

Best for:

- future MCP-compatible tools
- Windsurf
- VS Code MCP clients
- any custom MCP consumer

Flow:

1. user chooses `Generic MCP` in Trussen AI Connections
2. Trussen shows endpoint + auth format + ready config where possible
3. user pastes config into the MCP client
4. the MCP client connects
5. Trussen resolves the actor from token or OAuth
6. requests run through the shared executor and permission engine

### 16.5 ChatGPT Flow

Best for:

- hosted remote AI usage
- business users
- managers and owners

Recommended production flow:

1. ChatGPT supports connecting Trussen as a remote integration
2. user clicks `Connect Trussen`
3. ChatGPT redirects the user to Trussen login / OAuth consent
4. user signs into Trussen
5. Trussen issues user-bound access
6. ChatGPT calls Trussen on behalf of that user
7. Trussen sees the real user identity and role

Simple rule:

- ChatGPT should act as the actual Trussen employee, not as a shared workspace token

### 16.6 ChatGPT Enterprise Flow

Best for:

- companies using ChatGPT at org scale

Correct enterprise behavior:

1. company admin approves or installs Trussen once
2. Trussen becomes available to employees in ChatGPT Enterprise
3. each employee connects their own Trussen account once
4. each employee gets their own Trussen identity inside ChatGPT
5. Trussen permissions are enforced per employee

Important:

- admin install is shared
- employee identity is personal

### 16.7 Claude Flow

Best for:

- hosted AI usage when Claude supports the needed remote integration flow

Recommended behavior:

1. user chooses Connect Trussen in Claude
2. Claude redirects the user to Trussen OAuth
3. user signs in
4. Trussen returns user-bound access
5. Claude uses that user identity for future requests

### 16.8 Claude Enterprise Flow

Best for:

- companies using Claude across teams

Correct behavior:

1. company admin enables or installs Trussen once
2. employees see Trussen as an available integration
3. each employee connects their own Trussen account once
4. Claude uses each employee’s own Trussen identity

Important:

- the owner’s connection must not automatically give all employees owner access

### 16.9 Service Account / Bot Flow

Best for:

- analytics bots
- release automation
- CI/CD
- scheduled reporting

Flow:

1. admin creates a service account in Trussen
2. admin gives it narrow scopes
3. the bot/client uses that token
4. Trussen executes requests as the bot
5. audit logs show the bot identity, not a human user

### 16.10 Organization Install vs User Connect Flow

This is the most important plain-English rule.

`Install` means:

- Trussen is available inside the AI product for the company

`Connect` means:

- this exact employee is now linked to their own Trussen identity

`Authorize` means:

- Trussen checks what that employee is allowed to do

Example:

1. company owner installs Trussen in Claude Enterprise
2. Bob opens Claude
3. Bob clicks `Connect Trussen`
4. Bob signs into Trussen
5. Bob asks `show my issues`
6. Trussen returns Bob’s issues, not the owner’s issues

### 16.11 PAT vs OAuth vs Service Account in Simple English

Use `OAuth` when:

- a human user is connecting an AI app and should act as themselves

Use `PAT` when:

- a developer or power user is connecting a local tool like Codex or Cursor

Use `Service Account` when:

- automation or bots need limited, non-human access

### 16.12 Final Plain-English Summary

The intended production model is:

- one company can install Trussen once
- many employees can use it
- every human employee acts as themselves
- every bot acts as a bot
- every request is permission-checked
- no delete behavior is exposed through AI
- all actions are audited

This gives Trussen a secure, enterprise-safe, multi-client AI architecture without coupling the product to one AI provider.
