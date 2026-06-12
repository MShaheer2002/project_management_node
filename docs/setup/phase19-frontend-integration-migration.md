# Phase 19 — Integration Module: Frontend Migration Guide

## Why This Migration

The backend integration module was restructured from a monolithic design (one JSON config column, shared endpoints) to a normalized, provider-isolated architecture. This document tells the frontend exactly what changed, what broke, and how to fix it.

## What Changed (Summary)

| Before | After |
|---|---|
| One `PATCH /integrations/:provider/settings` for all providers | Separate per-provider: `PATCH /integrations/github/settings`, `/slack/settings`, `/discord/settings` |
| Settings + channel routing sent as one JSON blob | Settings = `PATCH /settings`, Channels = `POST/DELETE /channels` (separate CRUD) |
| `GET /integrations` returned `config` with nested settings/routing | `GET /integrations` returns `providerMeta` only. Settings/channels via `GET /:provider/settings` |
| Discord webhooks sent in `webhookRouting` inside settings PATCH | Discord webhooks = `POST/DELETE /integrations/discord/webhooks` (separate CRUD) |
| Slack channels sent in `channelRouting` inside settings PATCH | Slack channels = `POST/DELETE /integrations/slack/channels` (separate CRUD) |

---

## Complete API Reference

### Shared Endpoints

#### `GET /integrations` — List All Integrations

Returns connection status for all providers. No settings or routing data — use provider-specific `/settings` endpoint for that.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "provider": "github",
      "connected": true,
      "connectedAt": "2026-06-11T10:05:21Z",
      "connectedBy": { "id": "user_xxx", "name": "Shaheer", "email": "shaheer@example.com" },
      "providerMeta": {
        "githubUser": { "login": "MShaheer02", "id": 211340752 },
        "repos": ["MShaheer02/test-project-git-integration"],
        "scope": "repo admin:repo_hook"
      }
    },
    {
      "provider": "slack",
      "connected": true,
      "connectedAt": "2026-06-11T19:54:00Z",
      "connectedBy": { "id": "user_xxx", "name": "Shaheer", "email": "shaheer@example.com" },
      "providerMeta": { "botUserId": "U123", "team": { "id": "T123", "name": "Banyor" } }
    },
    {
      "provider": "discord",
      "connected": true,
      "connectedAt": "2026-06-12T18:20:47Z",
      "connectedBy": { "id": "user_xxx", "name": "Shaheer", "email": "shaheer@example.com" },
      "providerMeta": null
    },
    {
      "provider": "figma",
      "connected": false,
      "connectedAt": null,
      "connectedBy": null,
      "providerMeta": null
    }
  ]
}
```

#### `DELETE /integrations/:provider/disconnect` — Disconnect Any Provider

**Response:** `204 No Content`

Clears all data: token, settings, channels/webhooks.

---

### GitHub Endpoints

#### `POST /integrations/github/connect`

**Response:**
```json
{ "success": true, "data": { "authUrl": "https://github.com/login/oauth/authorize?..." } }
```
Frontend redirects to `authUrl`. GitHub redirects back to backend callback → backend redirects to frontend with `?provider=github&status=connected`.

#### `GET /integrations/github/settings`

**Response:**
```json
{
  "success": true,
  "data": {
    "settings": {
      "autoCompleteOnMerge": true,
      "autoMoveToReviewOnPr": true,
      "notifyOnPrOpen": true,
      "notifyOnPrReview": true,
      "notifyOnPrMerge": true,
      "showCommits": true,
      "showBranches": true
    },
    "githubUser": { "login": "MShaheer02", "id": 211340752, "avatarUrl": "..." },
    "repos": ["MShaheer02/test-project-git-integration"]
  }
}
```

#### `PATCH /integrations/github/settings`

**Request:**
```json
{
  "autoCompleteOnMerge": false,
  "showCommits": true
}
```
Only send changed fields. Partial update.

**Response:**
```json
{ "success": true, "data": { "settings": { "autoCompleteOnMerge": false, ... } } }
```

---

### Slack Endpoints

#### `POST /integrations/slack/connect`

**Response:**
```json
{ "success": true, "data": { "authUrl": "https://slack.com/oauth/v2/authorize?..." } }
```
Same OAuth redirect pattern as GitHub.

#### `GET /integrations/slack/settings`

**Response:**
```json
{
  "success": true,
  "data": {
    "settings": {
      "notifyOnIssueCreatedUrgent": true,
      "notifyOnIssueCompleted": true,
      "notifyOnIssueAssigned": false,
      "notifyOnCycleStarted": true,
      "notifyOnCycleCompleted": true,
      "dmOnAssignment": true,
      "dmOnMention": true,
      "dmOnDueDateApproaching": true,
      "slashCommandsEnabled": true
    },
    "channels": [
      {
        "id": "uuid-of-db-row",
        "channelId": "C0B9JNTT69M",
        "channelName": "#social",
        "scope": "default",
        "scopeId": null
      },
      {
        "id": "uuid-of-db-row-2",
        "channelId": "C0BA07FB7NE",
        "channelName": "#dev",
        "scope": "project",
        "scopeId": "bc9a9c35-913a-420a-83a6-14a18c95ba25"
      }
    ],
    "team": { "id": "T123", "name": "Banyor" }
  }
}
```

#### `PATCH /integrations/slack/settings`

Only boolean toggles — no channel routing here.

**Request:**
```json
{
  "notifyOnIssueCreatedUrgent": true,
  "dmOnAssignment": false
}
```

#### `GET /integrations/slack/channels` — List Available Slack Channels (for Picker)

Fetches channels from the Slack API (not from DB). Used to populate the channel dropdown picker.

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": "C0B9JNTT69M", "name": "social", "isPrivate": false, "memberCount": 2 },
    { "id": "C0BA07FB7NE", "name": "new-channel", "isPrivate": false, "memberCount": 2 },
    { "id": "C0BAUFR7YHE", "name": "all-banyor", "isPrivate": false, "memberCount": 2 }
  ]
}
```

#### `POST /integrations/slack/channels` — Add Channel Mapping

**Request:**
```json
{
  "channelId": "C0BA07FB7NE",
  "channelName": "#dev",
  "scope": "project",
  "scopeId": "bc9a9c35-913a-420a-83a6-14a18c95ba25"
}
```

Scope values:
- `"default"` — fallback channel (scopeId is null)
- `"project"` — project-specific (scopeId = project UUID)
- `"team"` — team-specific (scopeId = team UUID)
- `"urgent"` — urgent/high priority overlay (scopeId is null)

**Response:** `201` with created channel mapping object.

#### `DELETE /integrations/slack/channels/:channelDbId` — Remove Channel Mapping

**Path param:** `channelDbId` = the `id` from the channel mapping (DB row UUID, NOT the Slack channel ID)

**Response:** `204 No Content`

---

### Discord Endpoints

#### `POST /integrations/discord/connect`

**Request:**
```json
{
  "webhookUrl": "https://discord.com/api/webhooks/123456/abcdef...",
  "label": "#dev-updates"
}
```
No OAuth redirect — inline form submission.

**Response:**
```json
{ "success": true, "data": { "provider": "discord", "label": "#dev-updates" } }
```

#### `GET /integrations/discord/settings`

**Response:**
```json
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
    "webhooks": [
      {
        "id": "uuid-of-db-row",
        "url": "https://discord.com/api/webhooks/123/abc...",
        "label": "#dev-updates",
        "scope": "default",
        "scopeId": null
      },
      {
        "id": "uuid-of-db-row-2",
        "url": "https://discord.com/api/webhooks/456/def...",
        "label": "#design",
        "scope": "project",
        "scopeId": "bc9a9c35-913a-420a-83a6-14a18c95ba25"
      }
    ]
  }
}
```

#### `PATCH /integrations/discord/settings`

Only boolean toggles — no webhook routing here.

**Request:**
```json
{
  "notifyOnIssueCreatedUrgent": true,
  "notifyOnIssueAssigned": true
}
```

#### `POST /integrations/discord/webhooks` — Add Webhook Mapping

**Request:**
```json
{
  "url": "https://discord.com/api/webhooks/456/def...",
  "label": "#design",
  "scope": "project",
  "scopeId": "bc9a9c35-913a-420a-83a6-14a18c95ba25"
}
```

Scope values: same as Slack (`"default"`, `"project"`, `"team"`, `"urgent"`)

**Response:** `201` with created webhook object.

#### `DELETE /integrations/discord/webhooks/:webhookDbId` — Remove Webhook

**Path param:** `webhookDbId` = the `id` from the webhook mapping (DB row UUID)

**Response:** `204 No Content`

---

## Frontend Service Changes

### Old Service (Replace)

```typescript
// OLD — one service for everything
const integrationService = {
  list: () => privateApi.get('/integrations'),
  connect: (provider) => privateApi.post(`/integrations/${provider}/connect`),
  disconnect: (provider) => privateApi.delete(`/integrations/${provider}/disconnect`),
  getSettings: (provider) => privateApi.get(`/integrations/${provider}/settings`),
  updateSettings: (provider, settings) => privateApi.patch(`/integrations/${provider}/settings`, settings),
};
```

### New Service (Split by Provider)

```typescript
// NEW — shared
export const integrationService = {
  list: async (): Promise<IntegrationItem[]> => {
    const { data } = await privateApi.get('/integrations');
    return data.data;
  },
  disconnect: async (provider: string): Promise<void> => {
    await privateApi.delete(`/integrations/${provider}/disconnect`);
  },
};

// NEW — GitHub
export const githubService = {
  connect: async () => {
    const { data } = await privateApi.post('/integrations/github/connect');
    return data.data; // { authUrl }
  },
  getSettings: async () => {
    const { data } = await privateApi.get('/integrations/github/settings');
    return data.data; // { settings, githubUser, repos }
  },
  updateSettings: async (settings: Partial<GitHubSettings>) => {
    const { data } = await privateApi.patch('/integrations/github/settings', settings);
    return data.data;
  },
};

// NEW — Slack
export const slackService = {
  connect: async () => {
    const { data } = await privateApi.post('/integrations/slack/connect');
    return data.data; // { authUrl }
  },
  getSettings: async () => {
    const { data } = await privateApi.get('/integrations/slack/settings');
    return data.data; // { settings, channels, team }
  },
  updateSettings: async (settings: Partial<SlackSettings>) => {
    const { data } = await privateApi.patch('/integrations/slack/settings', settings);
    return data.data;
  },
  listChannels: async () => {
    const { data } = await privateApi.get('/integrations/slack/channels');
    return data.data; // Available Slack channels for picker
  },
  addChannel: async (input: AddSlackChannelInput) => {
    const { data } = await privateApi.post('/integrations/slack/channels', input);
    return data.data;
  },
  removeChannel: async (channelDbId: string) => {
    await privateApi.delete(`/integrations/slack/channels/${channelDbId}`);
  },
};

// NEW — Discord
export const discordService = {
  connect: async (input: ConnectDiscordInput) => {
    const { data } = await privateApi.post('/integrations/discord/connect', input);
    return data.data;
  },
  getSettings: async () => {
    const { data } = await privateApi.get('/integrations/discord/settings');
    return data.data; // { settings, webhooks }
  },
  updateSettings: async (settings: Partial<DiscordSettings>) => {
    const { data } = await privateApi.patch('/integrations/discord/settings', settings);
    return data.data;
  },
  addWebhook: async (input: AddDiscordWebhookInput) => {
    const { data } = await privateApi.post('/integrations/discord/webhooks', input);
    return data.data;
  },
  removeWebhook: async (webhookDbId: string) => {
    await privateApi.delete(`/integrations/discord/webhooks/${webhookDbId}`);
  },
};
```

---

## Frontend Types

### Shared Types

```typescript
interface IntegrationItem {
  provider: 'github' | 'slack' | 'discord' | 'figma';
  connected: boolean;
  connectedAt: string | null;
  connectedBy: { id: string; name: string; email: string } | null;
  providerMeta: Record<string, any> | null;
}
```

### GitHub Types

```typescript
interface GitHubSettings {
  autoCompleteOnMerge: boolean;
  autoMoveToReviewOnPr: boolean;
  notifyOnPrOpen: boolean;
  notifyOnPrReview: boolean;
  notifyOnPrMerge: boolean;
  showCommits: boolean;
  showBranches: boolean;
}

interface GitHubSettingsResponse {
  settings: GitHubSettings;
  githubUser: { login: string; id: number; avatarUrl: string } | null;
  repos: string[];
}
```

### Slack Types

```typescript
interface SlackSettings {
  notifyOnIssueCreatedUrgent: boolean;
  notifyOnIssueCompleted: boolean;
  notifyOnIssueAssigned: boolean;
  notifyOnCycleStarted: boolean;
  notifyOnCycleCompleted: boolean;
  dmOnAssignment: boolean;
  dmOnMention: boolean;
  dmOnDueDateApproaching: boolean;
  slashCommandsEnabled: boolean;
}

interface SlackChannelMapping {
  id: string;          // DB row UUID — use this for DELETE
  channelId: string;   // Slack channel ID (e.g., "C0B9JNTT69M")
  channelName: string; // Display name (e.g., "#social")
  scope: 'default' | 'project' | 'team' | 'urgent';
  scopeId: string | null;
}

interface AddSlackChannelInput {
  channelId: string;
  channelName: string;
  scope: 'default' | 'project' | 'team' | 'urgent';
  scopeId?: string;   // Required if scope is "project" or "team"
}

interface SlackAvailableChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  memberCount: number;
}

interface SlackSettingsResponse {
  settings: SlackSettings;
  channels: SlackChannelMapping[];
  team: { id: string; name: string } | null;
}
```

### Discord Types

```typescript
interface DiscordSettings {
  notifyOnIssueCreatedUrgent: boolean;
  notifyOnIssueCompleted: boolean;
  notifyOnIssueAssigned: boolean;
  notifyOnStatusChange: boolean;
  notifyOnCycleStarted: boolean;
  notifyOnCycleCompleted: boolean;
  notifyOnProjectCompleted: boolean;
}

interface DiscordWebhookMapping {
  id: string;          // DB row UUID — use this for DELETE
  url: string;         // Full Discord webhook URL
  label: string;       // Display name (e.g., "#dev-updates")
  scope: 'default' | 'project' | 'team' | 'urgent';
  scopeId: string | null;
}

interface AddDiscordWebhookInput {
  url: string;
  label: string;
  scope: 'default' | 'project' | 'team' | 'urgent';
  scopeId?: string;    // Required if scope is "project" or "team"
}

interface ConnectDiscordInput {
  webhookUrl: string;
  label?: string;
}

interface DiscordSettingsResponse {
  settings: DiscordSettings;
  webhooks: DiscordWebhookMapping[];
}
```

---

## Key Changes for Settings Panels

### Before (Broken Pattern)

```typescript
// OLD — one PATCH with everything jammed together
await integrationService.updateSettings('slack', {
  notifyOnIssueCreatedUrgent: true,  // toggle
  defaultChannelId: 'C123',          // channel config
  channelRouting: {                   // routing config
    projects: { 'uuid': [{ channelId: 'C456', channelName: '#dev' }] },
  },
});
```

### After (Correct Pattern)

```typescript
// NEW — settings and channels are separate operations

// 1. Update toggles
await slackService.updateSettings({ notifyOnIssueCreatedUrgent: true });

// 2. Add a channel mapping
await slackService.addChannel({
  channelId: 'C456',
  channelName: '#dev',
  scope: 'project',
  scopeId: 'project-uuid',
});

// 3. Remove a channel mapping (use the DB row ID, not the Slack channel ID)
await slackService.removeChannel('db-row-uuid');
```

Same pattern for Discord — `addWebhook` / `removeWebhook` instead of sending the whole routing object.

---

## Settings Panel Data Flow

### Slack Settings Panel

```
1. Panel opens
2. Fetch: GET /integrations/slack/settings
   → Returns: { settings: {...}, channels: [...], team: {...} }
3. Populate toggles from settings
4. Populate channel list from channels array
5. For channel picker dropdown: GET /integrations/slack/channels (Slack API)

6. User toggles a setting:
   → PATCH /integrations/slack/settings { notifyOnIssueCreatedUrgent: false }

7. User adds a project channel:
   → POST /integrations/slack/channels { channelId, channelName, scope: "project", scopeId: "project-uuid" }
   → Refetch: GET /integrations/slack/settings (to refresh channels list)

8. User removes a channel:
   → DELETE /integrations/slack/channels/{channel.id}   ← the DB row UUID
   → Refetch settings
```

### Discord Settings Panel

```
1. Panel opens
2. Fetch: GET /integrations/discord/settings
   → Returns: { settings: {...}, webhooks: [...] }
3. Populate toggles from settings
4. Populate webhook list from webhooks array

5. User toggles a setting:
   → PATCH /integrations/discord/settings { notifyOnIssueAssigned: true }

6. User adds a project webhook:
   → POST /integrations/discord/webhooks { url, label, scope: "project", scopeId: "project-uuid" }
   → Refetch: GET /integrations/discord/settings

7. User removes a webhook:
   → DELETE /integrations/discord/webhooks/{webhook.id}   ← the DB row UUID
   → Refetch settings
```

### GitHub Settings Panel

```
1. Panel opens
2. Fetch: GET /integrations/github/settings
   → Returns: { settings: {...}, githubUser: {...}, repos: [...] }
3. Populate toggles from settings
4. Show GitHub user and repos info

5. User toggles a setting:
   → PATCH /integrations/github/settings { autoCompleteOnMerge: false }
```

No channel/webhook routing for GitHub — just boolean toggles.

---

## Integrations Page Changes

### `GET /integrations` Response Changed

**Before:**
```json
{
  "provider": "slack",
  "connected": true,
  "config": {
    "settings": {...},
    "channelRouting": {...},
    "defaultChannelId": "C123",
    "team": {...}
  }
}
```

**After:**
```json
{
  "provider": "slack",
  "connected": true,
  "providerMeta": { "team": { "id": "T123", "name": "Banyor" } }
}
```

Settings and channel routing are NOT in the list response anymore. Use `GET /integrations/:provider/settings` when the settings panel opens.

### What to Show from List Response

- `connected` → show Connected/Not Connected badge
- `connectedAt` → "Connected Jun 11, 2026"
- `connectedBy.name` → "Connected by Shaheer"
- `providerMeta.team.name` → "Workspace: Banyor" (Slack)
- `providerMeta.githubUser.login` → "@MShaheer02" (GitHub)
- `providerMeta` is `null` for Discord (no identity metadata)

---

## Query Key Changes

```typescript
// Each provider gets its own settings query key
const integrationQueryKeys = {
  all: ['integrations'] as const,
  list: (workspaceId) => [...integrationQueryKeys.all, 'list', workspaceId],
  githubSettings: (workspaceId) => [...integrationQueryKeys.all, 'github', 'settings', workspaceId],
  slackSettings: (workspaceId) => [...integrationQueryKeys.all, 'slack', 'settings', workspaceId],
  slackChannels: (workspaceId) => [...integrationQueryKeys.all, 'slack', 'channels', workspaceId],
  discordSettings: (workspaceId) => [...integrationQueryKeys.all, 'discord', 'settings', workspaceId],
};
```

---

## Migration Checklist

### Step 1: Update Types
- [ ] Replace old `Integration` type with new `IntegrationItem` (no `config` field)
- [ ] Add per-provider settings types (`GitHubSettings`, `SlackSettings`, `DiscordSettings`)
- [ ] Add channel/webhook mapping types with `scope` and `scopeId`

### Step 2: Update Services
- [ ] Split old `integrationService` into `githubService`, `slackService`, `discordService`
- [ ] Settings PATCH only sends boolean toggles
- [ ] Channel/webhook management uses separate POST/DELETE endpoints

### Step 3: Update Settings Panels
- [ ] GitHub settings: fetch from `/integrations/github/settings`
- [ ] Slack settings: fetch from `/integrations/slack/settings`, channels from `/slack/channels`
- [ ] Discord settings: fetch from `/integrations/discord/settings`
- [ ] Channel routing uses `POST /channels` + `DELETE /channels/:id` (not PATCH settings)
- [ ] Webhook routing uses `POST /webhooks` + `DELETE /webhooks/:id` (not PATCH settings)

### Step 4: Update Integrations Page
- [ ] Remove `config` reading from list response
- [ ] Show provider metadata from `providerMeta` field
- [ ] Settings panel data fetched separately on open (not from list)

### Step 5: Update Query Keys
- [ ] Invalidate correct per-provider keys on mutations
- [ ] Refetch settings after channel/webhook add/remove

### Step 6: Test
- [ ] GitHub: connect, settings toggle, disconnect, reconnect
- [ ] Slack: connect, settings toggle, add channel, remove channel, disconnect
- [ ] Discord: connect, settings toggle, add webhook, remove webhook, disconnect
- [ ] Channel routing: project-specific channel receives notification instead of default
- [ ] Webhook routing: project-specific webhook receives embed instead of default
