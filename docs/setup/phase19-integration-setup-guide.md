# Phase 19 — Integration Module: Architecture & Setup Guide

## Overview

The Trussen integration module connects external tools (GitHub, Slack, Discord, Figma, and future providers) to workspace workflows. Each provider is fully isolated — its own routes, controller, service, schemas, and notification logic. No shared settings endpoints, no shared validation, no JSON blobs.

## Architecture

```
                    ┌──────────────────────────────────┐
                    │           app.ts                  │
                    │   /integrations → router          │
                    │   /webhooks     → webhook router  │
                    └──────────┬───────────┬────────────┘
                               │           │
              ┌────────────────┤           │
              │                │           │
    ┌─────────▼──┐  ┌─────────▼──┐  ┌─────▼──────┐
    │  GitHub/   │  │  Slack/    │  │  Discord/  │
    │  routes    │  │  routes    │  │  routes    │
    │  controller│  │  controller│  │  controller│
    │  service   │  │  service   │  │  service   │
    │  schemas   │  │  schemas   │  │  schemas   │
    │  utils     │  │  notify    │  │  notify    │
    │            │  │  dm        │  │  utils     │
    │            │  │  commands  │  │            │
    │            │  │  utils     │  │            │
    └────────────┘  └────────────┘  └────────────┘
              │                │           │
              └────────────────┤           │
                               │           │
                    ┌──────────▼───────────▼────────────┐
                    │         dispatcher.ts              │
                    │  dispatchIntegrationEvent()        │
                    │  → calls each provider's notify   │
                    └──────────────────────────────────┘
                               ▲
                               │
                    ┌──────────┴───────────────────────┐
                    │  issue.service.ts                 │
                    │  cycle.service.ts                 │
                    │  comment.service.ts               │
                    │  (one call per event)             │
                    └──────────────────────────────────┘
```

## Database Schema

### Tables

```
Integration (base record)
├── id              UUID PK
├── workspaceId     FK → Workspace
├── provider        ENUM (GITHUB, SLACK, DISCORD, FIGMA, ...)
├── connected       Boolean
├── accessToken     String (nullable) — OAuth token for GitHub/Slack
├── providerMeta    Json (nullable) — small stable identity data
├── connectedAt     DateTime
├── connectedById   FK → User
│
├── IntegrationSetting (1:many)
│   ├── id              UUID PK
│   ├── integrationId   FK → Integration (cascade delete)
│   ├── key             String (e.g., "autoCompleteOnMerge")
│   ├── enabled         Boolean
│   └── @@unique([integrationId, key])
│
├── IntegrationChannel (1:many) — Slack channel routing
│   ├── id              UUID PK
│   ├── integrationId   FK → Integration (cascade delete)
│   ├── channelId       String (Slack channel ID)
│   ├── channelName     String (display name)
│   ├── scope           String ("default" | "project" | "team" | "urgent")
│   ├── scopeId         String (nullable) — projectId or teamId
│   └── @@unique([integrationId, channelId, scope, scopeId])
│
└── IntegrationWebhook (1:many) — Discord webhook routing
    ├── id              UUID PK
    ├── integrationId   FK → Integration (cascade delete)
    ├── url             String (Discord webhook URL)
    ├── label           String (display name)
    ├── scope           String ("default" | "project" | "team" | "urgent")
    ├── scopeId         String (nullable) — projectId or teamId
    └── @@unique([integrationId, scope, scopeId, url])
```

### Why This Structure

| Question | Answer |
|---|---|
| Why not one JSON column? | Can't query settings across workspaces, can't enforce FK on scopeId, can't index, schema conflicts between providers |
| Why `IntegrationSetting` as key/value? | Adding a new setting = insert a row, no migration. Each provider defines its own keys, no conflicts. |
| Why separate `IntegrationChannel` and `IntegrationWebhook`? | Slack uses channel IDs (from Slack API), Discord uses webhook URLs (user-pasted). Different credentials, different validation. |
| Why `scope` + `scopeId`? | One table handles all routing: default (scopeId=null), project-specific, team-specific, urgent (scopeId=null). No separate tables for each. |
| Why `providerMeta` JSON? | Small stable data (GitHub username, Slack team name) set once on connect, rarely changes, always read together. Not worth a table. |
| Why `accessToken` as a column? | Needs to be read on every webhook/notification. Separate from settings which are read less frequently. |

### Channel/Webhook Resolution Logic

When a notification event fires, the system resolves which channels/webhooks to post to:

```
1. Check SCOPE = "project" where scopeId = issue.projectId
   → Found? → Post to ALL matched channels/webhooks

2. If no project match → Check SCOPE = "team" where scopeId = issue.teamId
   → Found? → Post to ALL matched

3. If no project or team match → Check SCOPE = "default"
   → Found? → Post there

4. ALWAYS also check SCOPE = "urgent" (if issue priority is high/urgent)
   → Found? → Post there IN ADDITION to whatever was found above
```

This logic is identical for Slack (queries `IntegrationChannel`) and Discord (queries `IntegrationWebhook`).

## File Structure

```
modules/integration/
│
├── integration.routes.ts       (74 lines)
│   Aggregator — mounts provider sub-routers:
│     GET  /integrations                       → list all
│     DELETE /integrations/:provider/disconnect → disconnect any
│     /integrations/github/*                   → github sub-router
│     /integrations/slack/*                    → slack sub-router
│     /integrations/discord/*                  → discord sub-router
│
├── integration.service.ts      (173 lines)
│   Shared logic:
│     listIntegrations(workspaceId)            → returns all providers with status
│     disconnectProvider(workspaceId, provider) → clears token, settings, channels/webhooks
│     getSettings(integrationId)               → reads IntegrationSetting rows
│     upsertSettings(integrationId, settings)  → writes IntegrationSetting rows
│     initDefaultSettings(integrationId, defaults) → creates defaults if not exist
│     findConnectedIntegration(workspaceId, provider) → returns integration or null
│
├── integration.types.ts        (57 lines)
│   Shared event payload types:
│     IntegrationEvent (discriminated union)
│     IssueEventPayload, IssueCompletedPayload, IssueAssignedPayload, CycleEventPayload
│
├── dispatcher.ts               (43 lines)
│   Single entry point for all notification dispatch:
│     dispatchIntegrationEvent(workspaceId, event)
│     → calls each registered provider's handleEvent()
│     → fire-and-forget, failures logged but never thrown
│
├── github/
│   ├── github.routes.ts        (59 lines)
│   │   POST /connect, GET /callback, GET /settings, PATCH /settings
│   ├── github.controller.ts    (133 lines)
│   │   connect, callback, getSettings, updateSettings, githubWebhook
│   ├── github.service.ts       (656 lines)
│   │   OAuth flow, webhook event processing (push, PR, review)
│   ├── github.schemas.ts       (24 lines)
│   │   7 boolean settings
│   └── github.utils.ts         (85 lines)
│       extractIssueRefs(), verifyGitHubSignature()
│
├── slack/
│   ├── slack.routes.ts         (93 lines)
│   │   POST /connect, GET /callback, GET/PATCH /settings, GET/POST/DELETE /channels
│   ├── slack.controller.ts     (126 lines)
│   │   connect, callback, getSettings, updateSettings, listChannels, addChannel, removeChannel, slackCommandsWebhook
│   ├── slack.service.ts        (313 lines)
│   │   OAuth flow, channel management, Slack API helpers
│   ├── slack.notify.ts         (257 lines)
│   │   handleEvent() for dispatcher, channel resolution, outbound notifications
│   ├── slack.dm.ts             (150 lines)
│   │   dmIssueAssigned, dmMentioned, dmDueDateApproaching
│   ├── slack.commands.ts       (298 lines)
│   │   Slash command handlers: create, status, my-issues, cycle, help
│   ├── slack.schemas.ts        (39 lines)
│   │   Settings toggles, channel add/remove schemas
│   └── slack.utils.ts          (175 lines)
│       verifySlackSignature(), Block Kit message builders
│
├── discord/
│   ├── discord.routes.ts       (78 lines)
│   │   POST /connect, GET/PATCH /settings, POST/DELETE /webhooks
│   ├── discord.controller.ts   (77 lines)
│   │   connect, getSettings, updateSettings, addWebhook, removeWebhook
│   ├── discord.service.ts      (265 lines)
│   │   Connect (webhook URL), webhook CRUD, resolution
│   ├── discord.notify.ts       (301 lines)
│   │   handleEvent() for dispatcher, embed posting, webhook resolution
│   ├── discord.schemas.ts      (54 lines)
│   │   Webhook URL validation, settings toggles, webhook add/remove
│   └── discord.utils.ts        (72 lines)
│       maskWebhookUrl(), buildIssueEmbed(), color constants
│
└── webhooks/
    └── webhook.routes.ts       (36 lines)
        POST /webhooks/github, POST /webhooks/slack/commands
```

**Total: 24 files, 3,638 lines. Every file under 300 lines** (except github.service.ts at 656 which contains all webhook event processing — inherently complex, could be split further if needed).

## Provider Comparison

| Feature | GitHub | Slack | Discord |
|---|---|---|---|
| **Auth method** | OAuth (access token) | OAuth (bot token) | Webhook URL (no OAuth) |
| **Token storage** | `Integration.accessToken` | `Integration.accessToken` | None — URL in `IntegrationWebhook` |
| **Identity data** | `providerMeta.githubUser` | `providerMeta.team` | None |
| **Settings table** | 7 boolean keys | 9 boolean keys | 7 boolean keys |
| **Channel/webhook routing** | None | `IntegrationChannel` | `IntegrationWebhook` |
| **Inbound webhooks** | Push, PR, PR review | Slash commands | None |
| **Outbound notifications** | Activity feed only | Channel messages + DMs | Rich embeds |
| **Connect endpoint** | Returns `authUrl` (redirect) | Returns `authUrl` (redirect) | Takes `webhookUrl` (inline form) |

## Settings Keys Per Provider

### GitHub

| Key | Default | Description |
|---|---|---|
| `autoCompleteOnMerge` | `true` | Move issue to "Done" when linked PR is merged |
| `autoMoveToReviewOnPr` | `true` | Move issue to "Review" when PR is opened |
| `notifyOnPrOpen` | `true` | Notify assignee when PR is opened |
| `notifyOnPrReview` | `true` | Notify assignee when PR is reviewed |
| `notifyOnPrMerge` | `true` | Notify assignee + creator when PR is merged |
| `showCommits` | `true` | Show commit activity in issue activity feed |
| `showBranches` | `true` | Show branch activity in issue activity feed |

### Slack

| Key | Default | Description |
|---|---|---|
| `notifyOnIssueCreatedUrgent` | `true` | Post to channel when high/urgent issue created |
| `notifyOnIssueCompleted` | `true` | Post to channel when issue completed |
| `notifyOnIssueAssigned` | `false` | Post to channel when issue assigned |
| `notifyOnCycleStarted` | `true` | Post to channel when cycle starts |
| `notifyOnCycleCompleted` | `true` | Post to channel when cycle completes |
| `dmOnAssignment` | `true` | DM user when assigned an issue |
| `dmOnMention` | `true` | DM user when mentioned in a comment |
| `dmOnDueDateApproaching` | `true` | DM user when due date is near |
| `slashCommandsEnabled` | `true` | Enable `/trussen` slash commands |

### Discord

| Key | Default | Description |
|---|---|---|
| `notifyOnIssueCreatedUrgent` | `true` | Post embed when high/urgent issue created |
| `notifyOnIssueCompleted` | `true` | Post embed when issue completed |
| `notifyOnIssueAssigned` | `false` | Post embed when issue assigned |
| `notifyOnStatusChange` | `false` | Post embed on any status change |
| `notifyOnCycleStarted` | `true` | Post embed when cycle starts |
| `notifyOnCycleCompleted` | `true` | Post embed when cycle completes |
| `notifyOnProjectCompleted` | `true` | Post embed when project completes |

## Dispatcher Pattern

### How Notification Events Flow

```
Issue created in Trussen
  │
  ├─ issue.service.ts calls:
  │   dispatchIntegrationEvent(workspaceId, {
  │     type: "issue.created",
  │     payload: { id, title, priority, projectId, teamId, ... }
  │   })
  │
  ├─ dispatcher.ts:
  │   → Loads slack.notify.handleEvent (lazy import)
  │   → Loads discord.notify.handleEvent (lazy import)
  │   → Calls both in parallel via Promise.allSettled
  │   → If one fails, the other still runs
  │
  ├─ slack.notify.handleEvent:
  │   1. findConnectedIntegration(workspaceId, "SLACK")
  │   2. If not connected → return (no-op)
  │   3. getSettings(integrationId) → check notifyOnIssueCreatedUrgent
  │   4. If disabled → return
  │   5. resolveChannels(integrationId, { projectId, teamId, priority })
  │      → Queries IntegrationChannel table (project → team → default → +urgent)
  │   6. Post Slack message to each resolved channel
  │
  └─ discord.notify.handleEvent:
      1. findConnectedIntegration(workspaceId, "DISCORD")
      2. If not connected → return (no-op)
      3. getSettings(integrationId) → check notifyOnIssueCreatedUrgent
      4. If disabled → return
      5. resolveWebhooks(integrationId, { projectId, teamId, priority })
         → Queries IntegrationWebhook table (project → team → default → +urgent)
      6. Post Discord embed to each resolved webhook URL
```

### Event Types

| Event | When | Dispatched From |
|---|---|---|
| `issue.created` | Issue created with high/urgent priority | `issue.service.ts` → `createIssue` |
| `issue.completed` | Issue status changed to "Done" | `issue.service.ts` → `updateIssue`, `updateIssueStatus` |
| `issue.assigned` | Issue assignee changed | `issue.service.ts` → `updateIssue` |
| `cycle.started` | Cycle status changed to "Current" | Not wired yet |
| `cycle.completed` | Cycle status changed to "Completed" | Not wired yet |

## Environment Variables

| Variable | Required | Used By | Description |
|---|---|---|---|
| `GITHUB_CLIENT_ID` | For GitHub | GitHub OAuth | OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | For GitHub | GitHub OAuth | OAuth App client secret |
| `GITHUB_WEBHOOK_SECRET` | For GitHub | Webhook verification | HMAC secret for signature verification |
| `SLACK_CLIENT_ID` | For Slack | Slack OAuth | Slack App client ID |
| `SLACK_CLIENT_SECRET` | For Slack | Slack OAuth | Slack App client secret |
| `SLACK_SIGNING_SECRET` | For Slack | Slash commands | HMAC secret for command verification |
| `BACKEND_URL` | For OAuth | All OAuth | Backend URL for redirect URIs (ngrok in dev) |
| — | — | Discord | **No env vars needed** — webhook URL is the credential |

All are optional — the server starts without them. Provider endpoints return a "not configured" error if the env vars are missing.

## Security Model

| Concern | Implementation |
|---|---|
| OAuth tokens | Stored in `Integration.accessToken` column. Never returned in list API. Only used server-side. |
| Discord webhook URLs | Stored in `IntegrationWebhook.url`. Full URLs only returned in `GET /settings` (ADMIN only). List API shows labels only. |
| Webhook signature verification | GitHub: HMAC SHA-256 via `x-hub-signature-256`. Slack: HMAC SHA-256 via `x-slack-signature` + timestamp (5-min replay window). |
| Webhook URLs never logged | Discord `maskWebhookUrl()` logs only `webhook:1234567890` (the ID, not the token). |
| Workspace isolation | All queries include `workspaceId`. Unique constraint `[workspaceId, provider]` prevents cross-tenant leaks. |
| Role enforcement | Connect/disconnect/settings require ADMIN or OWNER role. List is available to all members. |
| Cascade delete | Deleting a workspace cascades to Integration → IntegrationSetting, IntegrationChannel, IntegrationWebhook. |
| Disconnect cleanup | GitHub: removes webhooks from repos (best-effort). All providers: clears token, settings, channels/webhooks. |

## Adding a New Provider

### 1. Create module (5-6 files)

```
modules/integration/teams/
├── teams.routes.ts
├── teams.controller.ts
├── teams.service.ts
├── teams.schemas.ts
└── teams.notify.ts
```

### 2. Register in 2 files

**`integration.routes.ts`:**
```typescript
router.use("/teams", async (req, res, next) => {
  const { default: teamsRoutes } = await import("./teams/teams.routes.js");
  return teamsRoutes(req, res, next);
});
```

**`dispatcher.ts`:**
```typescript
const providers = {
  slack: () => import("./slack/slack.notify.js"),
  discord: () => import("./discord/discord.notify.js"),
  teams: () => import("./teams/teams.notify.js"),
};
```

### 3. Add Prisma enum

```prisma
enum IntegrationProvider {
  GITHUB
  SLACK
  DISCORD
  FIGMA
  TEAMS
}
```

### 4. Migration

```sql
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'TEAMS';
```

### Zero changes in

- `issue.service.ts` — dispatcher handles it
- `integration.service.ts` — shared helpers work for any provider
- Any other provider's code — fully isolated
- `IntegrationSetting` — just insert rows with new keys
- `IntegrationChannel` / `IntegrationWebhook` — reuse whichever fits

## Testing Checklist

### GitHub
- [ ] Connect via OAuth → repos discovered → webhooks registered
- [ ] Push commit with `PREFIX-N` in message → activity logged on issue
- [ ] Open PR with `PREFIX-N` in title → issue moved to Review (if enabled)
- [ ] Merge PR → issue moved to Done (if enabled)
- [ ] PR review → notification sent to assignee
- [ ] Settings: toggle autoCompleteOnMerge off → PR merge does NOT complete issue
- [ ] Disconnect → webhooks removed from repos → settings cleared

### Slack
- [ ] Connect via OAuth → bot token stored
- [ ] Set default channel → stored in IntegrationChannel
- [ ] Create urgent issue → channel notification posted
- [ ] Complete issue → channel notification posted
- [ ] Assign issue → DM sent to assignee (if enabled)
- [ ] `/trussen help` → shows commands
- [ ] `/trussen create Test --priority high` → issue created
- [ ] `/trussen status PREFIX-1` → issue details returned
- [ ] Add project channel → project issues go to that channel, not default
- [ ] Remove project channel → falls back to default
- [ ] Disconnect → bot token cleared → settings + channels cleared

### Discord
- [ ] Connect with webhook URL → URL verified → stored in IntegrationWebhook
- [ ] Create urgent issue → embed posted to default webhook
- [ ] Complete issue → embed posted
- [ ] Add project webhook → project issues go to that webhook, not default
- [ ] Remove project webhook → falls back to default
- [ ] Reconnect with new URL → existing routing preserved
- [ ] Disconnect → all webhooks + settings cleared

### Cross-Provider
- [ ] Create urgent issue → both Slack channel AND Discord webhook receive notification
- [ ] One provider fails → other still receives notification (independent)
- [ ] Disconnect one provider → other continues working
- [ ] Settings for one provider → does not affect other provider
