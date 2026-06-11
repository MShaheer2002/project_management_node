# Phase 19a — GitHub Integration: Frontend Integration Guide

## Overview

This guide tells the frontend team exactly what to build to integrate the GitHub connection flow, display GitHub activity on issues, and manage integration settings. The backend is already implemented.

## Current Frontend State

| Element | Status | Action |
|---|---|---|
| `IntegrationsPage.tsx` | Exists with mock data | Migrate to real API |
| `MOCK_INTEGRATIONS` in `mocks/integrations.ts` | Mock data | Replace with `useIntegrations()` hook |
| `Integration` type in `types.ts` | Exists but incomplete | Update with new fields |
| `/integrations` route in `routes.tsx` | Exists with `isLead` guard | Keep as-is |
| Sidebar "Integrations" link | Exists with `leadOnly` flag | Keep as-is |
| `IssueIntegrationRef` type | Exists | Used by GitHub activity on issues |
| Integration service | Does not exist | Create |
| Integration hooks | Do not exist | Create |
| GitHub settings panel | Does not exist | Create |
| Issue GitHub activity section | Does not exist | Create |

## Recommended New Files

```
src/features/integrations/
├── services/integrationService.ts
├── hooks/useIntegrationData.ts
├── hooks/useIntegrationMutations.ts
├── types.ts
└── components/
    ├── GitHubSettingsPanel.tsx
    └── IssueGitHubActivity.tsx
```

---

## 1. Backend API Contract

### 1.1 Endpoints

```
GET    /integrations                        — List all integrations + status
POST   /integrations/:provider/connect      — Start OAuth (returns auth URL)
GET    /integrations/:provider/callback     — OAuth callback (GitHub redirects here)
DELETE /integrations/:provider/disconnect   — Disconnect integration
PATCH  /integrations/:provider/settings     — Update provider settings
```

All endpoints except the callback require:
- Clerk JWT authentication
- Active workspace context (`X-Workspace-Id` header)
- List is available to all members; connect/disconnect/settings require ADMIN or OWNER

### 1.2 List Response

**`GET /integrations`**

```json
{
  "success": true,
  "data": [
    {
      "provider": "github",
      "connected": true,
      "connectedAt": "2026-06-10T12:00:00Z",
      "connectedBy": {
        "id": "user_xxx",
        "name": "Shaheer Qureshi",
        "email": "shaheer@example.com"
      }
    },
    {
      "provider": "slack",
      "connected": false,
      "connectedAt": null,
      "connectedBy": null
    },
    {
      "provider": "discord",
      "connected": false,
      "connectedAt": null,
      "connectedBy": null
    },
    {
      "provider": "figma",
      "connected": false,
      "connectedAt": null,
      "connectedBy": null
    }
  ]
}
```

### 1.3 Connect Response

**`POST /integrations/github/connect`**

```json
{
  "success": true,
  "data": {
    "authUrl": "https://github.com/login/oauth/authorize?client_id=xxx&redirect_uri=http://localhost:3000/integrations/github/callback&scope=repo&state=xxx"
  }
}
```

The frontend should redirect the user to `authUrl` in the same tab. After GitHub authorization, the user is redirected back to:

```
http://localhost:3000/integrations/github/callback?code=xxx&state=xxx
```

### 1.4 OAuth Callback Flow

The callback URL goes to the **frontend**, not the backend directly. The frontend must:

1. Extract `code` and `state` from URL query params
2. Forward them to the backend: `GET /integrations/github/callback?code=xxx&state=xxx`
3. Backend exchanges the code for an access token and stores it
4. Backend redirects to: `http://localhost:3000/integrations?provider=github&status=connected`
5. Frontend reads query params and shows success toast

**Alternative (simpler, current backend behavior):**

The backend's OAuth callback endpoint (`GET /integrations/github/callback`) already redirects to the frontend URL with status params. So the redirect URI in the OAuth flow can point directly to the backend callback:

```
Backend callback: http://localhost:8000/integrations/github/callback
  ↓ (after processing)
Redirects to: http://localhost:3000/integrations?provider=github&status=connected
```

The frontend just needs to handle the redirect params on the `/integrations` page:

```typescript
// In IntegrationsPage.tsx or a useEffect
const [searchParams] = useSearchParams();
const provider = searchParams.get('provider');
const status = searchParams.get('status');
const errorMessage = searchParams.get('message');

useEffect(() => {
  if (provider && status === 'connected') {
    showToast(`${provider} connected successfully`, 'success');
    // Clean up URL params
    window.history.replaceState({}, '', '/integrations');
    // Refetch integrations list
    queryClient.invalidateQueries({ queryKey: integrationQueryKeys.list(workspaceId) });
  } else if (provider && status === 'error') {
    showToast(errorMessage || `Failed to connect ${provider}`, 'error');
    window.history.replaceState({}, '', '/integrations');
  }
}, [provider, status]);
```

### 1.5 Disconnect Response

**`DELETE /integrations/github/disconnect`**

Response: `204 No Content`

### 1.6 Update Settings Response

**`PATCH /integrations/github/settings`**

Request:
```json
{
  "autoCompleteOnMerge": true,
  "autoMoveToReviewOnPr": false,
  "notifyOnPrOpen": true
}
```

Response:
```json
{
  "success": true,
  "data": {
    "autoCompleteOnMerge": true,
    "autoMoveToReviewOnPr": false,
    "notifyOnPrOpen": true,
    "notifyOnPrReview": true,
    "notifyOnPrMerge": true,
    "showCommits": true,
    "showBranches": true
  }
}
```

---

## 2. Types

### 2.1 Update Existing `Integration` Type

The current type is too simple. Replace it:

```typescript
// src/features/integrations/types.ts

export interface IntegrationItem {
  provider: 'github' | 'slack' | 'discord' | 'figma';
  connected: boolean;
  connectedAt: string | null;
  connectedBy: {
    id: string;
    name: string;
    email: string;
  } | null;
}

export interface GitHubConnectResponse {
  authUrl: string;
}

export interface GitHubSettings {
  autoCompleteOnMerge: boolean;
  autoMoveToReviewOnPr: boolean;
  notifyOnPrOpen: boolean;
  notifyOnPrReview: boolean;
  notifyOnPrMerge: boolean;
  showCommits: boolean;
  showBranches: boolean;
}

export type UpdateGitHubSettingsInput = Partial<GitHubSettings>;
```

### 2.2 Provider Metadata (Static — Not from API)

Provider display information is static — the backend doesn't return names, descriptions, or logos. Keep this on the frontend:

```typescript
// src/features/integrations/types.ts

export interface ProviderMeta {
  id: string;
  name: string;
  description: string;
  logo: string;
  available: boolean; // false = "Coming soon"
}

export const PROVIDER_META: Record<string, ProviderMeta> = {
  github: {
    id: 'github',
    name: 'GitHub',
    description: 'Link branches, commits, and pull requests to issues. Auto-complete issues when PRs merge.',
    logo: 'https://cdn-icons-png.flaticon.com/512/25/25231.png',
    available: true,
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    description: 'Get issue updates in your channels. Create issues with slash commands.',
    logo: 'https://cdn-icons-png.flaticon.com/512/3800/3800024.png',
    available: false,
  },
  discord: {
    id: 'discord',
    name: 'Discord',
    description: 'Post workspace events to your Discord channels.',
    logo: 'https://cdn-icons-png.flaticon.com/512/5968/5968756.png',
    available: false,
  },
  figma: {
    id: 'figma',
    name: 'Figma',
    description: 'Link design files to issues and projects.',
    logo: 'https://cdn-icons-png.flaticon.com/512/5968/5968705.png',
    available: false,
  },
};
```

---

## 3. Service

```typescript
// src/features/integrations/services/integrationService.ts

import { privateApi } from '@shared/services/privateApi';
import type { ApiResponse } from '@shared/services/types';
import type {
  IntegrationItem,
  GitHubConnectResponse,
  GitHubSettings,
  UpdateGitHubSettingsInput,
} from '../types';
import type { AxiosRequestConfig } from 'axios';

export const integrationService = {
  /** GET /integrations — List all integrations + status */
  list: async (): Promise<IntegrationItem[]> => {
    const { data } = await privateApi.get<ApiResponse<IntegrationItem[]>>('/integrations');
    return data.data;
  },

  /** POST /integrations/:provider/connect — Start OAuth (returns redirect URL) */
  connect: async (provider: string): Promise<GitHubConnectResponse> => {
    const { data } = await privateApi.post<ApiResponse<GitHubConnectResponse>>(
      `/integrations/${provider}/connect`,
      {},
      { skipGlobalErrorToast: true } as AxiosRequestConfig & { skipGlobalErrorToast: boolean },
    );
    return data.data;
  },

  /** DELETE /integrations/:provider/disconnect — Disconnect */
  disconnect: async (provider: string): Promise<void> => {
    await privateApi.delete(`/integrations/${provider}/disconnect`, {
      skipGlobalErrorToast: true,
    } as AxiosRequestConfig & { skipGlobalErrorToast: boolean });
  },

  /** PATCH /integrations/:provider/settings — Update settings */
  updateSettings: async (provider: string, settings: UpdateGitHubSettingsInput): Promise<GitHubSettings> => {
    const { data } = await privateApi.patch<ApiResponse<GitHubSettings>>(
      `/integrations/${provider}/settings`,
      settings,
    );
    return data.data;
  },
};
```

---

## 4. Hooks

### 4.1 Query Hook

```typescript
// src/features/integrations/hooks/useIntegrationData.ts

import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/app/stores/useAuthStore';
import { integrationService } from '../services/integrationService';

export const integrationQueryKeys = {
  all: ['integrations'] as const,
  list: (workspaceId: string | undefined) =>
    [...integrationQueryKeys.all, 'list', workspaceId] as const,
};

export const useIntegrations = () => {
  const workspaceId = useAuthStore((s) => s.workspace?.id);
  return useQuery({
    queryKey: integrationQueryKeys.list(workspaceId),
    queryFn: integrationService.list,
    enabled: Boolean(workspaceId),
  });
};
```

### 4.2 Mutation Hooks

```typescript
// src/features/integrations/hooks/useIntegrationMutations.ts

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/app/stores/useAuthStore';
import { useToastStore } from '@/app/stores/useToastStore';
import { integrationService } from '../services/integrationService';
import { integrationQueryKeys } from './useIntegrationData';
import type { UpdateGitHubSettingsInput } from '../types';
import type { ApiAxiosError } from '@shared/services/types';

export const useConnectIntegration = () => {
  return useMutation({
    mutationFn: (provider: string) => integrationService.connect(provider),
    // No onSuccess — the OAuth redirect handles the rest
  });
};

export const useDisconnectIntegration = () => {
  const queryClient = useQueryClient();
  const workspaceId = useAuthStore((s) => s.workspace?.id);
  const showToast = useToastStore((s) => s.showToast);

  return useMutation({
    mutationFn: (provider: string) => integrationService.disconnect(provider),
    onSuccess: (_data, provider) => {
      queryClient.invalidateQueries({ queryKey: integrationQueryKeys.list(workspaceId) });
      showToast(`${provider} disconnected`, 'success');
    },
    onError: (err) => {
      const message = (err as ApiAxiosError).response?.data?.error?.message;
      showToast(message || 'Failed to disconnect', 'error');
    },
  });
};

export const useUpdateIntegrationSettings = () => {
  const queryClient = useQueryClient();
  const workspaceId = useAuthStore((s) => s.workspace?.id);
  const showToast = useToastStore((s) => s.showToast);

  return useMutation({
    mutationFn: ({ provider, settings }: { provider: string; settings: UpdateGitHubSettingsInput }) =>
      integrationService.updateSettings(provider, settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationQueryKeys.list(workspaceId) });
      showToast('Settings updated', 'success');
    },
  });
};
```

---

## 5. Integration Page Migration

### 5.1 Replace Data Source

Replace mock data with the real hook:

```typescript
// OLD
import { MOCK_INTEGRATIONS } from '../constants';

// NEW
import { useIntegrations } from '@features/integrations/hooks/useIntegrationData';
import { PROVIDER_META } from '@features/integrations/types';

const { data: integrations = [], isLoading } = useIntegrations();
```

### 5.2 Merge API Data with Provider Metadata

The API returns connection status. Provider display info (name, description, logo) is static:

```typescript
const enrichedIntegrations = Object.values(PROVIDER_META).map((meta) => {
  const apiData = integrations.find((i) => i.provider === meta.id);
  return {
    ...meta,
    connected: apiData?.connected ?? false,
    connectedAt: apiData?.connectedAt ?? null,
    connectedBy: apiData?.connectedBy ?? null,
  };
});
```

### 5.3 Connect Button Handler

```typescript
const connectIntegration = useConnectIntegration();

const handleConnect = async (provider: string) => {
  if (provider !== 'github') {
    showToast(`${provider} integration coming soon`, 'info');
    return;
  }

  try {
    const result = await connectIntegration.mutateAsync(provider);
    // Redirect to GitHub OAuth page
    window.location.href = result.authUrl;
  } catch (err) {
    const code = (err as ApiAxiosError).response?.data?.error?.code;
    if (code === 'GITHUB_NOT_CONFIGURED') {
      showToast('GitHub integration is not configured on this server', 'error');
    } else {
      showToast('Failed to start connection', 'error');
    }
  }
};
```

### 5.4 Disconnect Button Handler

```typescript
const disconnectIntegration = useDisconnectIntegration();
const [disconnectingProvider, setDisconnectingProvider] = useState<string | null>(null);

const handleDisconnect = (provider: string) => {
  // Show confirmation first
  setDisconnectingProvider(provider);
};

const confirmDisconnect = () => {
  if (!disconnectingProvider) return;
  disconnectIntegration.mutate(disconnectingProvider);
  setDisconnectingProvider(null);
};
```

### 5.5 Disconnect Confirmation Dialog

```
┌─────────────────────────────────────────────────────────────┐
│  Disconnect GitHub                                          │
│                                                             │
│  Are you sure? This will:                                   │
│  • Stop tracking branches, commits, and PRs on your issues │
│  • Remove auto-status updates on PR merge                  │
│  • Remove all GitHub settings for this workspace           │
│                                                             │
│  Your GitHub repositories and data will not be affected.    │
│                                                             │
│                              [Cancel]  [Disconnect]         │
└─────────────────────────────────────────────────────────────┘
```

### 5.6 OAuth Callback Handling

On the `/integrations` page, detect callback params and show feedback:

```typescript
const [searchParams, setSearchParams] = useSearchParams();

useEffect(() => {
  const provider = searchParams.get('provider');
  const status = searchParams.get('status');
  const message = searchParams.get('message');

  if (!provider || !status) return;

  if (status === 'connected') {
    showToast(`${provider} connected successfully`, 'success', 'Integration connected');
    queryClient.invalidateQueries({ queryKey: integrationQueryKeys.list(workspaceId) });
  } else if (status === 'error') {
    showToast(message || `Failed to connect ${provider}`, 'error', 'Connection failed');
  }

  // Clean URL
  setSearchParams({}, { replace: true });
}, [searchParams]);
```

### 5.7 Connected Card — Additional Info

When an integration is connected, show who connected it and when:

```typescript
{integration.connected && integration.connectedBy && (
  <div className="text-[11px] text-gray-400 mt-2">
    Connected by {integration.connectedBy.name} · {formatRelativeTime(integration.connectedAt)}
  </div>
)}
```

### 5.8 GitHub Settings Button

When GitHub is connected, show a Settings button that opens the settings panel:

```typescript
{integration.connected && integration.provider === 'github' && (
  <button
    onClick={() => setShowGitHubSettings(true)}
    className="px-3 py-1.5 rounded-md border border-gray-200 dark:border-border-dark text-xs font-semibold hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
  >
    Settings
  </button>
)}
```

### 5.9 "Coming Soon" State for Unavailable Providers

```typescript
{!meta.available && (
  <span className="px-3 py-1.5 rounded-md text-xs font-semibold text-gray-400 bg-gray-100 dark:bg-gray-800">
    Coming Soon
  </span>
)}
```

---

## 6. GitHub Settings Panel

A slide-over panel or modal that shows when the user clicks "Settings" on the GitHub card.

```
┌──────────────────────────────────────────────────────────────┐
│  GitHub Settings                                        [X]  │
│                                                              │
│  Automation                                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Auto-complete issue when PR is merged           [✓] │   │
│  │ Move issue to "Review" when PR is opened        [✓] │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Notifications                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Notify assignee when PR is opened               [✓] │   │
│  │ Notify assignee when PR is reviewed             [✓] │   │
│  │ Notify assignee when PR is merged               [✓] │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Display                                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Show commits in issue activity feed             [✓] │   │
│  │ Show branches in issue activity feed            [✓] │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Connection                                                  │
│  Connected by Shaheer Qureshi · Jun 10, 2026                │
│  GitHub user: @shaheer                                       │
│                                                              │
│                                           [Save Settings]    │
└──────────────────────────────────────────────────────────────┘
```

Each toggle calls `useUpdateIntegrationSettings` with the changed field. You can either save on each toggle change (auto-save) or collect all changes and save with a button.

---

## 7. Issue GitHub Activity Section

When an issue has GitHub activity linked (via the activity feed), show a **Development** section on the issue detail page.

### 7.1 How GitHub Activity Appears on Issues

The backend creates activity entries with specific types and metadata when GitHub events reference an issue. The frontend reads these from the existing activity feed endpoint.

**Activity types to filter for:**

| Activity Type | Display |
|---|---|
| `GITHUB_BRANCH_LINKED` | Branch created for this issue |
| `GITHUB_COMMIT_LINKED` | Commit referencing this issue |
| `GITHUB_PR_OPENED` | PR opened for this issue |
| `GITHUB_PR_MERGED` | PR merged for this issue |
| `GITHUB_PR_CLOSED` | PR closed without merge |
| `GITHUB_PR_REVIEW` | PR review submitted |

### 7.2 Activity Metadata Shape

Every GitHub activity entry has metadata with these fields:

```typescript
interface GitHubActivityMetadata {
  provider: 'github';
  repo: string;           // "owner/repo-name"
  entityId: string;       // Issue ID (e.g., "LIN-24")
  entityTitle: string;    // Issue title

  // Branch activity
  branch?: string;        // "feature/LIN-24-fix-login"

  // Commit activity
  sha?: string;           // Full commit SHA
  shortSha?: string;      // First 7 chars
  message?: string;       // Commit message
  url?: string;           // GitHub commit URL
  author?: string;        // Commit author name

  // PR activity
  prNumber?: number;      // PR number
  prTitle?: string;       // PR title
  prUrl?: string;         // GitHub PR URL
  prBranch?: string;      // Source branch
  prUser?: string;        // GitHub username who opened PR
  mergedAt?: string;      // When PR was merged (ISO 8601)

  // Review activity
  reviewState?: string;   // "approved" | "changes_requested" | "commented"
  reviewUser?: string;    // GitHub username who reviewed

  // Status change triggered by GitHub
  trigger?: string;       // "github_pr_opened" | "github_pr_merged"
  fromStatus?: string;
  toStatus?: string;
}
```

### 7.3 Development Section Component

Create a component that fetches issue activity and filters for GitHub types:

```typescript
// src/features/integrations/components/IssueGitHubActivity.tsx

const GITHUB_ACTIVITY_TYPES = [
  'GITHUB_BRANCH_LINKED',
  'GITHUB_COMMIT_LINKED',
  'GITHUB_PR_OPENED',
  'GITHUB_PR_MERGED',
  'GITHUB_PR_CLOSED',
  'GITHUB_PR_REVIEW',
];
```

Filter from the existing issue activity feed — no separate endpoint needed. The activity entries already arrive via `GET /activity?target=issue&targetId=LIN-24`.

### 7.4 Development Section UI

```
┌──────────────────────────────────────────────────────────────┐
│  Development                                                 │
│                                                              │
│  Branches                                                    │
│  🌿 feature/LIN-24-fix-login            acme/mobile-app     │
│                                                              │
│  Pull Requests                                               │
│  🟢 #142 Fix login crash on iOS Safari   Merged ✓            │
│     acme/mobile-app · merged 2 hours ago                     │
│                                                              │
│  Commits (3)                                                 │
│  📝 abc1234 "fix login crash"          Shaheer · 3 hours ago │
│  📝 def5678 "add Safari detection"     Shaheer · 2 hours ago │
│  📝 ghi9012 "update unit tests"        Shaheer · 2 hours ago │
└──────────────────────────────────────────────────────────────┘
```

**Rules:**
- Only show this section if there are any GitHub activities for the issue
- Group by type: branches first, then PRs, then commits
- PR status indicator: `🟡 Open`, `🟢 Merged`, `🔴 Changes requested`, `⚫ Closed`
- Commits show short SHA (7 chars), message (truncated), author, relative time
- Branch and PR names link to GitHub (open in new tab) using the `url`/`prUrl` from metadata
- If no GitHub activity exists, don't show the section at all (not even an empty state)

### 7.5 Activity Feed Integration

In the issue activity timeline, GitHub events should show alongside regular activity with a GitHub icon:

```typescript
// In your activity timeline renderer, detect GitHub activities:

const isGitHubActivity = (type: string) => type.startsWith('GITHUB_');

// Render with GitHub icon and appropriate styling:
{isGitHubActivity(activity.type) && (
  <img src={PROVIDER_META.github.logo} className="w-4 h-4" alt="GitHub" />
)}
```

Activity messages come from the backend's `description` field:
- "Branch feature/LIN-24-fix-login linked to LIN-24"
- "Commit abc1234 linked to LIN-24"
- "PR #142 opened for LIN-24"
- "PR #142 merged — LIN-24"
- "shaheer approved PR #142 for LIN-24"

---

## 8. Error Handling

| Code | Status | Frontend Action |
|---|---|---|
| `GITHUB_NOT_CONFIGURED` | 500 | "GitHub integration is not configured on this server." — disable Connect button |
| `GITHUB_OAUTH_FAILED` | 400 | "Failed to connect GitHub. Please try again." — redirect URL has error param |
| `INTEGRATION_NOT_CONNECTED` | 404 | "This integration is not connected." — refetch list |
| `INTEGRATION_PROVIDER_INVALID` | 400 | "Unknown provider." — should not happen with UI-driven flow |
| `INSUFFICIENT_ROLE` | 403 | "Only admins and owners can manage integrations." — hide buttons for non-admin |

---

## 9. Notification Types from GitHub

The backend sends these notifications for GitHub events. The frontend notification inbox/page should handle them:

| Notification | Message Example | Icon |
|---|---|---|
| PR opened | "PR #142 opened for LIN-24" | GitHub icon |
| PR review | "Ali approved PR #142 for LIN-24" | GitHub icon |
| PR merged | "PR #142 merged — LIN-24 completed" | GitHub icon + checkmark |

These are already handled by the existing notification system — they arrive as `type: "UPDATE"` with `metadata.provider: "github"`. The frontend can detect this and show a GitHub icon instead of the default update icon:

```typescript
const isGitHubNotification = notification.metadata?.provider === 'github';
```

---

## 10. Implementation Order

1. **Create types** — `IntegrationItem`, `GitHubSettings`, `PROVIDER_META`
2. **Create service** — `integrationService` with list, connect, disconnect, updateSettings
3. **Create hooks** — `useIntegrations`, `useConnectIntegration`, `useDisconnectIntegration`, `useUpdateIntegrationSettings`
4. **Migrate IntegrationsPage** — replace mock data with hooks, add OAuth flow, callback handling, disconnect confirmation
5. **Build GitHubSettingsPanel** — toggle settings with auto-save or manual save
6. **Build IssueGitHubActivity** — filter activity feed for GitHub types, show Development section
7. **Update activity timeline** — show GitHub icon for GitHub activities
8. **Update notification rendering** — detect GitHub notifications and show appropriate icon
9. **Remove mock data** — delete `MOCK_INTEGRATIONS` from mocks/constants
10. **Test** — full OAuth flow, settings changes, disconnect, activity display, notification icons

---

## 11. Testing Checklist

### OAuth Flow
- [ ] Click "Connect" on GitHub card → redirects to GitHub OAuth page
- [ ] After authorizing → redirects back to `/integrations?provider=github&status=connected`
- [ ] Success toast shown + integration list refreshed
- [ ] GitHub card now shows "Connected" with connected-by info
- [ ] OAuth failure → redirects with `status=error` → error toast shown

### Settings
- [ ] Click "Settings" on connected GitHub card → settings panel opens
- [ ] Toggle each setting → PATCH call made → saved correctly
- [ ] Settings panel shows current values from backend

### Disconnect
- [ ] Click "Disconnect" → confirmation dialog shown
- [ ] Confirm → card shows "Not Connected"
- [ ] Settings button disappears

### Issue Activity
- [ ] Create a commit with `LIN-XXX` in message → activity appears on issue
- [ ] Open PR with `LIN-XXX` in title → PR appears in Development section
- [ ] Merge PR → issue auto-completes (if setting enabled)
- [ ] Issue activity timeline shows GitHub entries with GitHub icon

### Notifications
- [ ] PR opened → assignee receives notification with GitHub icon
- [ ] PR review → assignee receives notification
- [ ] PR merged → assignee + creator receive notification

### Access Control
- [ ] MEMBER can see integration list but cannot connect/disconnect
- [ ] ADMIN can connect, disconnect, and change settings
- [ ] OWNER can connect, disconnect, and change settings
- [ ] GUEST cannot access `/integrations` page

### Edge Cases
- [ ] Connect when already connected → backend upserts, no error
- [ ] Disconnect when not connected → 404 error, handled gracefully
- [ ] GitHub not configured on server → "not configured" error shown, Connect button disabled
- [ ] Multiple LIN references in one PR → all referenced issues updated
- [ ] PR with no LIN reference → silently ignored, no errors

---

## 12. Done When

- [ ] Integration page loads real data from `GET /integrations`
- [ ] GitHub OAuth connect flow works end-to-end
- [ ] GitHub card shows connection status, connected-by, and settings button
- [ ] GitHub settings panel allows toggling all 7 settings
- [ ] Disconnect shows confirmation and cleans up immediately
- [ ] Issue detail page shows Development section for GitHub-linked issues
- [ ] Activity timeline shows GitHub entries with GitHub icon
- [ ] Notifications from GitHub events show with GitHub icon
- [ ] Unavailable providers show "Coming Soon" state
- [ ] `MOCK_INTEGRATIONS` removed from codebase
