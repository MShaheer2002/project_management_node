# Phase 19b — Slack Integration: Frontend Integration Guide

## Overview

The Slack integration backend is implemented. This guide tells the frontend exactly what to build for the connection flow, settings management, and how Slack notifications work.

## What the Backend Does

| Feature | How It Works |
|---|---|
| **OAuth connect** | `POST /integrations/slack/connect` → returns Slack auth URL → user authorizes → callback stores bot token |
| **Channel notifications** | When issues are created/completed/assigned or cycles start/complete, messages post to configured Slack channel |
| **Personal DMs** | When a user is assigned, mentioned, or has a due date approaching — DM sent to their Slack (matched by email) |
| **Slash commands** | `/linearis create`, `/linearis status TES-1`, `/linearis my-issues`, `/linearis cycle` |
| **Disconnect** | Clears all tokens and settings |

## Backend Endpoints

Same endpoints as GitHub — the integration system is provider-agnostic:

```
POST   /integrations/slack/connect       → { authUrl: "https://slack.com/oauth/v2/authorize?..." }
GET    /integrations/slack/callback      → OAuth callback (Slack redirects here)
DELETE /integrations/slack/disconnect    → 204
PATCH  /integrations/slack/settings      → update Slack-specific settings
POST   /webhooks/slack/commands          → Slack slash command receiver (no auth)
```

## OAuth Flow

Identical pattern to GitHub:

```
1. Admin clicks "Connect" on Slack card
2. Frontend calls POST /integrations/slack/connect
3. Backend returns { authUrl: "https://slack.com/oauth/v2/authorize?..." }
4. Frontend redirects: window.location.href = authUrl
5. User authorizes Linearis in Slack
6. Slack redirects to backend: /integrations/slack/callback?code=xxx&state=xxx
7. Backend exchanges code for bot token, stores it
8. Backend redirects to: http://localhost:3000/integrations?provider=slack&status=connected
9. Frontend shows success toast, refreshes integration list
```

The existing OAuth callback handling on the `/integrations` page already supports this — it reads `provider` and `status` from query params. The same code that handles `provider=github` will work for `provider=slack`.

## Slack Settings

After connecting, the admin can configure these settings via `PATCH /integrations/slack/settings`:

### Channel Notifications

| Setting | Default | Description |
|---|---|---|
| `notifyOnIssueCreatedUrgent` | `true` | Post to channel when high/urgent issue is created |
| `notifyOnIssueCompleted` | `true` | Post to channel when an issue is completed |
| `notifyOnIssueAssigned` | `false` | Post to channel when an issue is assigned |
| `notifyOnCycleStarted` | `true` | Post to channel when a cycle starts |
| `notifyOnCycleCompleted` | `true` | Post to channel when a cycle completes |

### Personal DMs

| Setting | Default | Description |
|---|---|---|
| `dmOnAssignment` | `true` | DM user when assigned an issue |
| `dmOnMention` | `true` | DM user when mentioned in a comment |
| `dmOnDueDateApproaching` | `true` | DM user when issue due date is approaching |

### Slash Commands

| Setting | Default | Description |
|---|---|---|
| `slashCommandsEnabled` | `true` | Enable `/linearis` slash commands |

### Request Example

```json
PATCH /integrations/slack/settings
{
  "notifyOnIssueCreatedUrgent": true,
  "notifyOnIssueCompleted": true,
  "notifyOnIssueAssigned": false,
  "dmOnAssignment": true,
  "dmOnMention": true,
  "slashCommandsEnabled": true
}
```

Response:
```json
{
  "success": true,
  "data": {
    "notifyOnIssueCreatedUrgent": true,
    "notifyOnIssueCompleted": true,
    "notifyOnIssueAssigned": false,
    "notifyOnCycleStarted": true,
    "notifyOnCycleCompleted": true,
    "dmOnAssignment": true,
    "dmOnMention": true,
    "dmOnDueDateApproaching": true,
    "slashCommandsEnabled": true
  }
}
```

## Slack Settings Panel UI

When the admin clicks "Settings" on the connected Slack card:

```
┌──────────────────────────────────────────────────────────────┐
│  Slack Settings                                         [X]  │
│                                                              │
│  Channel Notifications                                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Post when urgent/high issue is created          [✓] │   │
│  │ Post when issue is completed                    [✓] │   │
│  │ Post when issue is assigned                     [ ] │   │
│  │ Post when cycle starts                          [✓] │   │
│  │ Post when cycle completes                       [✓] │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Personal DM Notifications                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ DM when assigned an issue                       [✓] │   │
│  │ DM when mentioned in a comment                  [✓] │   │
│  │ DM when due date approaching                    [✓] │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Slash Commands                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Enable /linearis commands in Slack              [✓] │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Connection                                                  │
│  Connected by Shaheer Qureshi · Jun 11, 2026                │
│  Slack workspace: Acme Corp                                  │
│                                                              │
│                                           [Save Settings]    │
└──────────────────────────────────────────────────────────────┘
```

## Slash Commands — What Users See in Slack

These commands work automatically once Slack is connected. No frontend work needed — they're handled entirely between Slack and the backend.

### `/linearis create Fix payment timeout --priority high`

Response in Slack:
```
✅ Issue created
TES-6 Fix payment timeout
Priority: HIGH · Project: API Service
```

### `/linearis status TES-1`

Response:
```
📋 TES-1 Test for git
Status: TODO · Priority: MEDIUM
Assignee: Muhammad Shaheer · Project: Test Project
```

### `/linearis my-issues`

Response:
```
Your Open Issues (3)

🔴 TES-6 Fix payment timeout — IN_PROGRESS
🟡 TES-5 Add rate limiting — TODO
🔵 TES-1 Test for git — TODO
```

### `/linearis cycle`

Response:
```
📅 Sprint 15
Jun 15 – Jun 28

📈 Progress: 67% (12/18 issues)
✅ Done: 12 · 🔄 Remaining: 6
```

### `/linearis help`

Response:
```
Linearis Commands

/linearis create <title> --priority <low|medium|high|urgent> — Create an issue
/linearis status <TES-1> — Check issue status
/linearis my-issues — View your open issues
/linearis cycle — View current cycle progress
/linearis help — Show this help message
```

## Outbound Message Examples — What Appears in Slack Channels

These messages post automatically when events happen in Linearis. No frontend work needed — the backend sends them.

### Urgent Issue Created

```
🔴 Urgent Issue Created
TES-7 API crash on checkout

Priority    Urgent
Assignee    Ali Khan
Project     Payment Service
Created by  Shaheer Qureshi

[View in Linearis]
```

### Issue Completed

```
✅ Issue Completed
TES-5 Fix login bug

Completed by  Shaheer Qureshi
Project       Mobile App

[View in Linearis]
```

### Cycle Completed

```
🏁 Cycle Completed
Sprint 14 — Backend Team

Team        Backend
Period      Jun 1 – Jun 14
Issues      18
Completed   16
Velocity    89%

[View in Linearis]
```

## Slack App Setup (Required Before Testing)

The backend code is ready, but a Slack App must be created in the Slack API dashboard before the OAuth flow works.

### Steps

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. App name: `Linearis`, pick your Slack workspace
3. **OAuth & Permissions** → Add Bot Token Scopes:
   - `chat:write`, `chat:write.public`, `commands`, `users:read`, `users:read.email`, `im:write`
4. **OAuth & Permissions** → Add Redirect URL:
   - `https://<your-ngrok-or-backend-url>/integrations/slack/callback`
5. **Slash Commands** → Create New Command:
   - Command: `/linearis`
   - Request URL: `https://<your-ngrok-or-backend-url>/webhooks/slack/commands`
   - Short Description: `Manage Linearis issues`
   - Usage Hint: `create | status | my-issues | cycle | help`
6. **Basic Information** → Copy the **Signing Secret**
7. **OAuth & Permissions** → Copy **Client ID** and **Client Secret**
8. Add to `.env`:
   ```
   SLACK_CLIENT_ID=xxx
   SLACK_CLIENT_SECRET=xxx
   SLACK_SIGNING_SECRET=xxx
   ```

### Important Notes

- The Redirect URL and slash command Request URL must use your **backend URL** (ngrok in development), not `localhost`
- When ngrok URL changes, update both the Slack App dashboard AND your `BACKEND_URL` env var
- Slash commands are registered in the Slack App dashboard — the backend only handles the incoming requests

## How Slash Commands Resolve Users

When a developer types `/linearis my-issues` in Slack, the backend resolves their identity:

1. Slack sends the Slack `user_id` with the command
2. Backend calls Slack API `users.info` to get the user's email
3. Backend looks up that email in the Linearis User table
4. If found AND the user is a workspace member → commands run as that user
5. If not found → falls back to the admin who connected Slack

This means:
- `/linearis my-issues` shows the actual developer's issues, not the admin's
- `/linearis create` attributes the issue to the actual developer
- If a Slack user isn't in Linearis, commands still work but are attributed to the admin

## Frontend Changes Needed

### 1. Update PROVIDER_META

The Slack provider should now be `available: true`:

```typescript
slack: {
  id: 'slack',
  name: 'Slack',
  description: 'Get issue updates in your channels. Create and manage issues with slash commands.',
  logo: 'https://cdn-icons-png.flaticon.com/512/3800/3800024.png',
  available: true,  // Changed from false
},
```

### 2. Connect Handler

Same as GitHub — the existing `handleConnect` function already works if you add the `slack` case:

```typescript
const handleConnect = async (provider: string) => {
  if (provider !== 'github' && provider !== 'slack') {
    showToast(`${provider} integration coming soon`, 'info');
    return;
  }
  // ... existing OAuth flow code
};
```

### 3. Settings Panel

Build a `SlackSettingsPanel` (same pattern as `GitHubSettingsPanel`) with the toggles listed above. Both panels use the same `PATCH /integrations/:provider/settings` endpoint.

### 4. Disconnect

Existing disconnect flow already works for Slack — same endpoint pattern.

## Error Handling

| Code | Status | Message |
|---|---|---|
| `SLACK_NOT_CONFIGURED` | 500 | "Slack integration is not configured on this server" |
| `SLACK_OAUTH_FAILED` | 400 | "Failed to connect Slack. Please try again." |
| `INTEGRATION_NOT_CONNECTED` | 404 | "Slack is not connected" |
| `SLACK_SIGNATURE_INVALID` | 401 | Only relevant for slash commands — user never sees this |

## How DMs Are Matched

The backend matches Linearis users to Slack users **by email address**. When a user is assigned an issue in Linearis, the backend:

1. Gets the assignee's email from the Linearis User table
2. Calls `Slack users.lookupByEmail` API
3. If found → opens a DM channel and sends the notification
4. If not found → silently skips (user is not in the Slack workspace)

No frontend work needed for this — it's entirely backend-driven.

## Implementation Order

1. **Update `PROVIDER_META`** — set `slack.available = true`
2. **Update connect handler** — add `slack` to the allowed providers
3. **Build `SlackSettingsPanel`** — 9 toggles in 3 groups
4. **Test OAuth flow** — connect, verify toast, verify settings button appears
5. **Test disconnect** — verify clean disconnect
6. **Test slash commands in Slack** — `/linearis help`, `/linearis create`, etc.
7. **Test channel notifications** — create an urgent issue, verify Slack channel post

## Done When

- [ ] Slack OAuth connect works end-to-end
- [ ] Slack card shows "Connected" with workspace name
- [ ] Settings panel shows all 9 toggles
- [ ] Disconnect cleans up and shows "Not Connected"
- [ ] `/linearis create` creates an issue from Slack
- [ ] `/linearis status TES-1` returns issue details
- [ ] `/linearis my-issues` returns open issues
- [ ] `/linearis cycle` returns cycle progress
- [ ] Urgent issue creation posts to configured Slack channel
- [ ] Issue completion posts to configured Slack channel
- [ ] DM sent when user is assigned an issue
