# Phase 19d — Discord Integration: Frontend Integration Guide

## Overview

Discord integration is **outbound-only** — Trussen sends notifications to Discord channels via webhook URLs. There's no OAuth flow. The user pastes a Discord webhook URL, and Trussen posts rich embeds to it.

## Key Difference from GitHub/Slack

| | GitHub | Slack | Discord |
|---|---|---|---|
| Connect flow | OAuth redirect | OAuth redirect | **Paste webhook URL** (inline form) |
| Frontend opens external page | Yes | Yes | **No** |
| Callback handling | Yes | Yes | **No** |
| Channel picker from API | No | Yes (list channels) | **No** (user pastes webhook URL) |
| Slash commands | No | Yes | **No** |
| DMs | No | Yes | **No** |
| Env vars needed | 3 | 3 | **0** |

## Backend Endpoints

```
POST   /integrations/discord/connect       — Connect with webhook URL (no OAuth)
DELETE /integrations/discord/disconnect    — Disconnect
PATCH  /integrations/discord/settings      — Update settings + webhook routing
GET    /integrations/discord/settings      — Get current settings (ADMIN only, full URLs)
GET    /integrations                       — List integrations (URLs stripped, labels only)
```

## Connect Flow

Discord does NOT use OAuth. Instead of redirecting to an external page, the frontend shows an inline form.

### Step-by-Step

```
1. Admin clicks "Connect" on Discord card

2. Modal opens (NOT a redirect):

   ┌──────────────────────────────────────────────────────────────┐
   │  Connect Discord                                        [X]  │
   │                                                              │
   │  Paste a Discord webhook URL to receive notifications.       │
   │                                                              │
   │  ┌──────────────────────────────────────────────────────┐   │
   │  │ (i) How to create a webhook                          │   │
   │  │                                                      │   │
   │  │ 1. Open Discord                                      │   │
   │  │ 2. Right-click a channel → Edit Channel              │   │
   │  │ 3. Go to Integrations → Webhooks                     │   │
   │  │ 4. Click New Webhook → Copy URL                      │   │
   │  │ 5. Paste the URL below                               │   │
   │  └──────────────────────────────────────────────────────┘   │
   │                                                              │
   │  Webhook URL *                                               │
   │  ┌──────────────────────────────────────────────────────┐   │
   │  │ https://discord.com/api/webhooks/123.../abc...       │   │
   │  └──────────────────────────────────────────────────────┘   │
   │                                                              │
   │  Channel Label (optional)                                    │
   │  ┌──────────────────────────────────────────────────────┐   │
   │  │ #dev-updates                                         │   │
   │  └──────────────────────────────────────────────────────┘   │
   │  Helps you identify this channel in settings later           │
   │                                                              │
   │                              [Cancel]  [Connect Discord]     │
   └──────────────────────────────────────────────────────────────┘

3. Frontend validates URL client-side (see validation section below)

4. Frontend calls:
   POST /integrations/discord/connect
   { "webhookUrl": "https://discord.com/api/webhooks/...", "label": "#dev-updates" }

5. Backend validates URL format, verifies it's alive via Discord API, stores config

6. Success → toast "Discord connected" → refresh integration list
```

### Connect Request/Response

```typescript
// Request
POST /integrations/discord/connect
{
  "webhookUrl": "https://discord.com/api/webhooks/123456/abcdef...",
  "label": "#dev-updates"  // optional — defaults to Discord webhook name
}

// Success Response
{
  "success": true,
  "data": {
    "provider": "discord",
    "label": "#dev-updates"
  }
}
```

### Client-Side URL Validation

Validate before submitting to avoid unnecessary API calls:

```typescript
// Supports all Discord domains: discord.com, discordapp.com (legacy), discordptb.com (PTB)
const DISCORD_WEBHOOK_REGEX =
  /^https:\/\/(?:discord\.com|discordapp\.com|discordptb\.com)\/api\/webhooks\/\d+\/.+$/;

function isValidDiscordWebhookUrl(url: string): boolean {
  return DISCORD_WEBHOOK_REGEX.test(url);
}

// Validation messages:
// - Empty: "Webhook URL is required"
// - Invalid format: "Must be a Discord webhook URL (https://discord.com/api/webhooks/...)"
// - Looks like a regular Discord link: "This is a channel link, not a webhook URL. See instructions above."
```

### Connect Error Handling

| Backend Code | Status | Frontend Message |
|---|---|---|
| `VALIDATION_ERROR` | 400 | "Invalid Discord webhook URL" — show inline field error |
| `VALIDATION_ERROR` (deleted) | 400 | "This webhook URL has been deleted. Create a new one in Discord." |
| Already connected | 200 | Upsert — reconnecting replaces default webhook, preserves routing |

### Connect Handler in Frontend

Discord uses a different flow than GitHub/Slack — no OAuth redirect:

```typescript
const handleConnect = async (provider: string) => {
  if (provider === 'github' || provider === 'slack') {
    // OAuth redirect flow
    const result = await integrationService.connect(provider);
    window.location.href = result.authUrl;
    return;
  }

  if (provider === 'discord') {
    // Inline form — show modal, no redirect
    setShowDiscordConnectModal(true);
    return;
  }

  showToast(`${provider} integration coming soon`, 'info');
};
```

### Discord Connect Modal Component

```typescript
const DiscordConnectModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [webhookUrl, setWebhookUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connectMutation = useConnectDiscord();

  const handleSubmit = async () => {
    if (!webhookUrl.trim()) {
      setError('Webhook URL is required');
      return;
    }
    if (!isValidDiscordWebhookUrl(webhookUrl)) {
      setError('Must be a Discord webhook URL (https://discord.com/api/webhooks/...)');
      return;
    }
    try {
      await connectMutation.mutateAsync({ webhookUrl, label: label || undefined });
      showToast('Discord connected', 'success');
      onClose();
    } catch (err) {
      setError((err as ApiAxiosError).response?.data?.error?.message || 'Failed to connect');
    }
  };
  // ... render modal UI
};
```

## Settings Panel

After connecting, the admin configures notification toggles and webhook routing.

### Notification Toggles (7 settings)

| Setting | Key | Default |
|---|---|---|
| Urgent/high issue created | `notifyOnIssueCreatedUrgent` | `true` |
| Issue completed | `notifyOnIssueCompleted` | `true` |
| Issue assigned | `notifyOnIssueAssigned` | `false` |
| Issue status changed | `notifyOnStatusChange` | `false` |
| Cycle started | `notifyOnCycleStarted` | `true` |
| Cycle completed | `notifyOnCycleCompleted` | `true` |
| Project completed | `notifyOnProjectCompleted` | `true` |

### Settings Panel Wireframe

```
┌──────────────────────────────────────────────────────────────┐
│  Discord Settings                                       [X]  │
│                                                              │
│  Channel Notifications                                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Urgent/high issue created                       [✓] │   │
│  │ Issue completed                                 [✓] │   │
│  │ Issue assigned                                  [ ] │   │
│  │ Issue status changed                            [ ] │   │
│  │ Cycle started                                   [✓] │   │
│  │ Cycle completed                                 [✓] │   │
│  │ Project completed                               [✓] │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Default Webhook                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ #dev-updates                                        │   │
│  │ Connected · Click to change                  [Edit] │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Project Webhooks                                            │
│  Paste webhook URLs for project-specific Discord channels    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Mobile App                                          │   │
│  │   #mobile-dev (webhook URL)                    [x]  │   │
│  │   [+ Add webhook]                                   │   │
│  │                                                      │   │
│  │ API Service                                          │   │
│  │   #api-alerts (webhook URL)                    [x]  │   │
│  │   #api-general (webhook URL)                   [x]  │   │
│  │   [+ Add webhook]                                   │   │
│  │                                                      │   │
│  │ [+ Add project]                                     │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Team Webhooks                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Backend Team                                        │   │
│  │   #backend-team (webhook URL)                  [x]  │   │
│  │   [+ Add webhook]                                   │   │
│  │                                                      │   │
│  │ [+ Add team]                                        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Urgent Webhook                                              │
│  Posts here IN ADDITION to project/team/default channel      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ #incidents (webhook URL)                       [x]  │   │
│  │ or: [Set urgent webhook]                            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Connection                                                  │
│  Connected by Shaheer · Jun 12, 2026                         │
│                                                              │
│  [Disconnect Discord]                                        │
└──────────────────────────────────────────────────────────────┘
```

### Adding a Webhook to a Project/Team

Unlike Slack (dropdown channel picker), Discord requires pasting a webhook URL:

```
1. Admin clicks "+ Add project"
2. Select project from dropdown → project card appears
3. Click "+ Add webhook" under the project
4. Paste webhook URL + enter label:

   ┌──────────────────────────────────────────────────────┐
   │ Webhook URL                                          │
   │ ┌──────────────────────────────────────────────┐    │
   │ │ https://discord.com/api/webhooks/456/def...  │    │
   │ └──────────────────────────────────────────────┘    │
   │ Label                                                │
   │ ┌──────────────────────────────────────────────┐    │
   │ │ #mobile-dev                                  │    │
   │ └──────────────────────────────────────────────┘    │
   │                        [Cancel]  [Add Webhook]       │
   └──────────────────────────────────────────────────────┘

5. Validate URL client-side → save via PATCH /integrations/discord/settings
6. Webhook chip appears under the project with [x] to remove
```

Multiple webhooks per project/team are supported (same as Slack multi-channel).

### Settings Save Request

```json
PATCH /integrations/discord/settings
{
  "notifyOnIssueCreatedUrgent": true,
  "notifyOnIssueCompleted": true,
  "notifyOnIssueAssigned": false,
  "webhookRouting": {
    "projects": {
      "<project-uuid>": [
        { "url": "https://discord.com/api/webhooks/456/def...", "label": "#mobile-dev" },
        { "url": "https://discord.com/api/webhooks/789/ghi...", "label": "#mobile-general" }
      ]
    },
    "teams": {
      "<team-uuid>": [
        { "url": "https://discord.com/api/webhooks/012/jkl...", "label": "#backend-team" }
      ]
    },
    "urgent": {
      "url": "https://discord.com/api/webhooks/345/mno...",
      "label": "#incidents"
    }
  }
}
```

### Read Settings Response

```json
GET /integrations/discord/settings
{
  "success": true,
  "data": {
    "settings": {
      "notifyOnIssueCreatedUrgent": true,
      "notifyOnIssueCompleted": true,
      "notifyOnIssueAssigned": false,
      "notifyOnStatusChange": false,
      "notifyOnCycleStarted": true,
      "notifyOnCycleCompleted": true,
      "notifyOnProjectCompleted": true
    },
    "defaultWebhook": { "label": "#dev-updates" },
    "webhookRouting": {
      "projects": { ... },
      "teams": { ... },
      "urgent": { "url": "...", "label": "#incidents" }
    }
  }
}
```

**Note:** `GET /integrations` (the list endpoint) strips webhook URLs for security — only shows labels. The full `GET /integrations/discord/settings` endpoint (ADMIN only) returns the complete config including URLs.

## Frontend Types

```typescript
interface DiscordWebhookMapping {
  url: string;
  label: string;
}

interface DiscordSettings {
  notifyOnIssueCreatedUrgent: boolean;
  notifyOnIssueCompleted: boolean;
  notifyOnIssueAssigned: boolean;
  notifyOnStatusChange: boolean;
  notifyOnCycleStarted: boolean;
  notifyOnCycleCompleted: boolean;
  notifyOnProjectCompleted: boolean;
}

interface DiscordWebhookRouting {
  projects: Record<string, DiscordWebhookMapping[]>;
  teams: Record<string, DiscordWebhookMapping[]>;
  urgent: DiscordWebhookMapping | null;
}

interface ConnectDiscordInput {
  webhookUrl: string;
  label?: string;
}
```

## PROVIDER_META Update

```typescript
discord: {
  id: 'discord',
  name: 'Discord',
  description: 'Post issue and project updates to your Discord channels via webhook.',
  logo: 'https://cdn-icons-png.flaticon.com/512/5968/5968756.png',
  available: true,  // Changed from false
},
```

## Discord Message Preview — What Users See in Discord

### Urgent Issue Created
```
┌──────────────────────────────────────────────────┐
│  Trussen                                        │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│  🔴 Urgent Issue Created                    RED  │
│  TES-7 API crash on checkout                     │
│                                                  │
│  Priority    Urgent                              │
│  Assignee    Ali Khan                            │
│  Project     Payment Service                     │
│  Created by  Shaheer                             │
│                                                  │
│  Trussen · Today at 3:00 PM                     │
└──────────────────────────────────────────────────┘
```

### Issue Completed
```
┌──────────────────────────────────────────────────┐
│  Trussen                                        │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│  ✅ Issue Completed                       GREEN  │
│  TES-5 Fix login bug                             │
│                                                  │
│  Completed by  Shaheer                           │
│  Project       Mobile App                        │
│                                                  │
│  Trussen · Today at 5:00 PM                     │
└──────────────────────────────────────────────────┘
```

### Issue Assigned
```
┌──────────────────────────────────────────────────┐
│  Trussen                                        │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│  👤 Issue Assigned                        BLUE   │
│  TES-10 Add rate limiting                        │
│                                                  │
│  Assigned to   Ali Khan                          │
│  Assigned by   Shaheer                           │
│  Priority      Medium                            │
│                                                  │
│  Trussen · Today at 4:00 PM                     │
└──────────────────────────────────────────────────┘
```

### Cycle Completed
```
┌──────────────────────────────────────────────────┐
│  Trussen                                        │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│  🏁 Cycle Completed                      GREEN  │
│  Sprint 14 — Backend Team                        │
│                                                  │
│  Team        Backend                             │
│  Period      Jun 1 – Jun 14                      │
│  Completed   16                                  │
│  Velocity    89%                                 │
│                                                  │
│  Trussen · Today at 6:00 PM                     │
└──────────────────────────────────────────────────┘
```

All embeds are clickable — the title links to the issue/cycle in Trussen.

## Edge Cases

| Scenario | Frontend Behavior |
|---|---|
| User pastes non-Discord URL | Client-side validation rejects: "Must be a Discord webhook URL" |
| User pastes `discordapp.com` URL | Accepted — legacy domain supported |
| User pastes `discordptb.com` URL | Accepted — PTB domain supported |
| User pastes deleted webhook URL | Backend returns 400: "webhook URL is invalid or has been deleted" |
| User pastes regular Discord channel link | Client-side validation rejects (doesn't match `/api/webhooks/` pattern) |
| Reconnect with new URL | Existing project/team/urgent routing preserved, only default changes |
| Webhook deleted after connecting | Notifications silently skip — no error shown in Trussen |
| Same webhook URL for two projects | Allowed — deduplication at send time prevents double-posting |
| Multiple webhooks per project | Supported — same multi-channel pattern as Slack |
| Very long issue title | Truncated to 200 chars in Discord embed |
| `GET /integrations` as non-admin | Shows label only ("Connected to #dev-updates"), no webhook URL |

## Disconnect Confirmation

```
┌──────────────────────────────────────────────────────────────┐
│  Disconnect Discord                                          │
│                                                              │
│  Are you sure? This will:                                    │
│  • Stop all notifications to Discord channels                │
│  • Remove all webhook URL configurations                     │
│  • Remove all project/team channel mappings                  │
│                                                              │
│  Your Discord server and webhooks will not be affected.      │
│  You can reconnect anytime with a new webhook URL.           │
│                                                              │
│                              [Cancel]  [Disconnect]          │
└──────────────────────────────────────────────────────────────┘
```

## Implementation Order

1. **Update `PROVIDER_META`** — set `discord.available = true`
2. **Build `DiscordConnectModal`** — webhook URL + label input (inline, no OAuth redirect)
3. **Update connect handler** — show modal for Discord (not OAuth redirect)
4. **Build `DiscordSettingsPanel`** — 7 toggles + webhook routing with URL paste inputs
5. **Reuse `useConnectIntegration` mutation** — just pass `{ webhookUrl, label }` for Discord
6. **Test connect** — paste webhook URL, verify connection, verify settings persist
7. **Test notifications** — create urgent issue, check Discord for embed
8. **Test disconnect** — verify cleanup, verify reconnect preserves routing

## Done When

- [ ] Discord card shows "Connect" with inline webhook URL modal (no OAuth redirect)
- [ ] Webhook URL validated client-side (`discord.com`, `discordapp.com`, `discordptb.com`)
- [ ] Webhook URL validated server-side (format + alive check via Discord API)
- [ ] Connected state shows webhook label and settings button
- [ ] Settings panel has 7 notification toggles with correct defaults
- [ ] Default webhook editable
- [ ] Project webhook routing with URL paste + label input
- [ ] Team webhook routing with URL paste + label input
- [ ] Urgent webhook configurable
- [ ] Multiple webhooks per project/team supported
- [ ] Reconnect preserves existing routing and settings
- [ ] Disconnect shows confirmation dialog
- [ ] Disconnect clears all config
- [ ] Urgent issue creation posts rich embed to Discord
- [ ] Issue completion posts rich embed to Discord
- [ ] Embeds are color-coded by priority
- [ ] Embed titles link back to Trussen
- [ ] `GET /integrations` shows labels only, no webhook URLs (security)
