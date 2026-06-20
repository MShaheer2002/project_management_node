# Phase 19d — Discord Integration: Setup & Architecture Guide

## Overview

Discord integration sends outbound notifications from Trussen to Discord channels. Unlike GitHub (OAuth + webhooks) and Slack (OAuth + bot token), Discord uses **webhook URLs** — no OAuth, no bot, no app registration, no env vars.

## Architecture

```
Trussen Backend → HTTP POST (?wait=true) → Discord Webhook URL → Rich Embed in Channel
```

No tokens, no scopes, no callback URLs, no developer portal configuration.

## How Webhook URLs Work

1. A Discord server admin creates a webhook in any channel:
   **Channel Settings → Integrations → Webhooks → New Webhook → Copy URL**

2. The webhook URL looks like:
   ```
   https://discord.com/api/webhooks/1234567890/aBcDeFgHiJkLmNoPqRsTuVwXyZ...
   ```

3. Trussen stores this URL and POSTs JSON to it with `?wait=true`. Discord renders the message as a rich embed in the channel.

4. The URL itself IS the credential — anyone with the URL can post to that channel. Trussen treats webhook URLs as secrets (same security as Slack/GitHub tokens).

## Supported Discord Domains

The backend accepts webhook URLs from all Discord domains:
- `https://discord.com/api/webhooks/...` (standard)
- `https://discordapp.com/api/webhooks/...` (legacy domain)
- `https://discordptb.com/api/webhooks/...` (public test build)

## No Configuration Required

| Setup Step | GitHub | Slack | Discord |
|---|---|---|---|
| Developer portal app | Yes | Yes | **No** |
| OAuth credentials in .env | Yes | Yes | **No** |
| OAuth flow | Yes | Yes | **No** |
| Bot permissions | No | Yes | **No** |
| Webhook URL from user | No | No | **Yes** |

Zero env vars needed for Discord.

## Backend Implementation

### Files

| File | Purpose |
|---|---|
| `modules/integration/discord/discord.routes.ts` | Discord route definitions |
| `modules/integration/discord/discord.controller.ts` | Connect, settings, webhook CRUD handlers |
| `modules/integration/discord/discord.service.ts` | Connect flow, webhook CRUD, webhook resolution |
| `modules/integration/discord/discord.notify.ts` | Outbound Discord notification handler |
| `modules/integration/discord/discord.schemas.ts` | Webhook/settings validation |
| `modules/integration/discord/discord.utils.ts` | Safe logging + embed helpers |

### Endpoints

```
POST   /integrations/discord/connect       — Connect with webhook URL (no OAuth)
DELETE /integrations/discord/disconnect    — Disconnect, clear config
GET    /integrations/discord/settings      — Get current settings (ADMIN only, includes URLs)
PATCH  /integrations/discord/settings      — Update notification settings
POST   /integrations/discord/webhooks      — Add a scoped webhook mapping
DELETE /integrations/discord/webhooks/:webhookDbId — Remove a scoped webhook mapping
GET    /integrations                       — List integrations
```

### Connect Flow

```
POST /integrations/discord/connect
{
  "webhookUrl": "https://discord.com/api/webhooks/123/abc...",
  "label": "#dev-updates"
}
```

On connect, the backend:
1. Validates URL format (regex: must match `discord.com`, `discordapp.com`, or `discordptb.com` webhook pattern)
2. Verifies URL is alive by sending a GET request to Discord API
3. Uses Discord's response to confirm the webhook is alive
4. Preserves existing `webhookRouting` and `settings` if reconnecting (only updates the default webhook)
5. Stores the default webhook in `IntegrationWebhook`
6. Logs `INTEGRATION_CONNECTED` activity

### Reconnect Behavior

When a user reconnects Discord (e.g., changes the default webhook URL):
- The default webhook is replaced with the new URL
- **Existing project/team/urgent webhook routing is preserved** (not wiped)
- **Existing notification settings are preserved** (not reset to defaults)
- Only a fresh connect (from disconnected state) creates default settings

### Disconnect

Uses the existing generic disconnect endpoint:
```
DELETE /integrations/discord/disconnect
```
Clears all config (webhook URLs, routing, settings), sets `connected: false`.

### Config Shape Stored in DB

Discord uses the normalized integration schema:

- `Integration` — provider connection state (`connected`, `connectedAt`, `connectedById`)
- `IntegrationSetting` — one row per toggle
- `IntegrationWebhook` — one row per webhook mapping with:
  - `url`
  - `label`
  - `scope`: `default | project | team | urgent`
  - `scopeId`: project/team UUID when required

### Channel Resolution

Same priority logic as Slack:
1. **Project webhooks** — if the issue's project has mapped webhook(s), post to ALL of them
2. **Team webhooks** — if no project match, check team mapping, post to ALL
3. **Default webhook** — fallback (only if no project or team webhooks)
4. **Urgent webhook** — **ADDED ON TOP** for high/urgent issues (in addition to, not instead of)

Deduplication: if the same webhook URL appears in both project and urgent routing, the message is sent only once.

### Discord Embed Format

Messages use Discord's rich embed format with `?wait=true` for proper error detection:

```json
{
  "username": "Trussen",
  "embeds": [{
    "title": "🔴 Urgent Issue Created",
    "description": "[TES-7](http://localhost:3000/issues/TES-7) API crash on checkout",
    "color": 15548997,
    "fields": [
      { "name": "Priority", "value": "Urgent", "inline": true },
      { "name": "Assignee", "value": "Ali Khan", "inline": true },
      { "name": "Project", "value": "Payment Service", "inline": true }
    ],
    "footer": { "text": "Trussen" },
    "timestamp": "2026-06-12T10:00:00Z",
    "url": "http://localhost:3000/issues/TES-7"
  }]
}
```

### Discord Embed Limits (Enforced)

| Field | Discord Limit | Our Enforcement |
|---|---|---|
| Embed title | 256 chars | `.slice(0, 256)` |
| Embed description | 4096 chars | Issue title truncated to 200 chars |
| Field name | 256 chars | `.slice(0, 256)` |
| Field value | 1024 chars | `.slice(0, 1024)`, empty values replaced with `"—"` |
| Fields per embed | 25 max | `.slice(0, 25)` |
| Embeds per message | 10 max | We send 1 embed per message |

### Color Coding

| Priority/Type | Color | Hex |
|---|---|---|
| Urgent | Red | `0xef4444` |
| High | Orange | `0xf97316` |
| Medium | Blue | `0x3b82f6` |
| Low | Gray | `0x6b7280` |
| Completed | Green | `0x22c55e` |
| Info (cycle, etc.) | Purple | `0x8b5cf6` |

### Notification Events Wired

| Event | Setting Toggle | Wired In |
|---|---|---|
| Issue created (high/urgent) | `notifyOnIssueCreatedUrgent` | `issue.service.ts` — `createIssue` |
| Issue completed | `notifyOnIssueCompleted` | `issue.service.ts` — `updateIssue`, `updateIssueStatus` |
| Issue assigned | `notifyOnIssueAssigned` | `issue.service.ts` — `updateIssue` |
| Cycle started | `notifyOnCycleStarted` | `cycle.service.ts` — create/update/reopen when cycle becomes current |
| Cycle completed | `notifyOnCycleCompleted` | `cycle.service.ts` — `completeCycle` |
| Project completed | `notifyOnProjectCompleted` | `project.service.ts` — `updateProject` when status becomes completed |

All issue notifications fire to both Slack AND Discord simultaneously (fire-and-forget, independent of each other).

### Error Handling

| Scenario | Behavior |
|---|---|
| Webhook URL returns 404 (deleted on Discord) | Log warning with masked webhook ID, skip silently |
| Webhook URL returns 429 (rate limited) | Log warning with `retry-after` value, skip |
| Webhook URL unreachable (network) | Log warning, skip |
| Invalid webhook URL on connect | Return 400 validation error with clear message |
| Webhook verified on connect but later deleted | Notifications silently fail, no crash, no user-facing error |
| Empty field values in embed | Replaced with `"—"` to prevent Discord API rejection |
| Very long issue title (500 chars) | Truncated to 200 chars in embed description |
| More than 25 fields | Sliced to 25 (Discord max) |

### Security

| Rule | Implementation |
|---|---|
| Webhook URLs are secrets | Stored in `IntegrationWebhook`, treated same as OAuth tokens |
| URLs never logged | `maskWebhookUrl()` logs only `webhook:1234567890` (the ID portion, not the token) |
| URL validation on connect | Regex validates format, GET request verifies URL is alive |
| `GET /integrations` hides webhook secrets | Shared list endpoint only returns provider-level metadata, not webhook rows |
| `GET /integrations/discord/settings` returns URLs | Full config including webhook URLs — restricted to ADMIN/OWNER only |
| URL format enforcement | Only accepts `discord.com`, `discordapp.com`, `discordptb.com` webhook paths |

## Testing

### Happy Path
1. Create a webhook in a Discord channel (Channel Settings → Integrations → Webhooks → New → Copy URL)
2. Connect Discord: `POST /integrations/discord/connect { webhookUrl, label }`
3. Verify response: `{ provider: "discord", label: "#dev-updates" }`
4. Create an urgent issue → check Discord channel for the embed
5. Complete an issue → check Discord for completion notification
6. Assign an issue (with `notifyOnIssueAssigned` enabled) → check Discord

### Edge Cases to Test
- Connect with `discordapp.com` URL → should work
- Connect with invalid URL → 400 error
- Connect with deleted webhook URL → 400 error "webhook URL is invalid or has been deleted"
- Reconnect with new URL → existing routing preserved
- Delete webhook on Discord side → notifications silently skip, no error in Trussen
- Create issue with 500-char title → embed shows truncated title
- `GET /integrations` as MEMBER → Discord shows label only, no webhook URL
- Disconnect → all config cleared, card shows "Not Connected"
