# Phase 19c — Figma Integration: Frontend Integration Guide

## Overview

Figma integration is **read-only, link-based**. Designers paste Figma URLs in issues or projects, and Trussen fetches rich previews (thumbnail, file name, last modified) from the Figma API. No notifications, no webhooks, no dispatcher.

## How It Differs from Other Providers

| | GitHub | Slack | Discord | Figma |
|---|---|---|---|---|
| Connect | OAuth redirect | OAuth redirect | Paste webhook URL | **Paste access token** (inline form) |
| Outbound notifications | No | Yes | Yes | **No** |
| Inbound webhooks | Yes | Yes (slash commands) | No | **No** |
| Channel/webhook routing | No | Yes | Yes | **No** |
| Dispatcher registration | No | Yes | Yes | **No** |
| Main feature | Activity linking | Notifications + commands | Notifications | **Design previews** |

## Backend Endpoints

```
POST  /integrations/figma/connect         — Connect with personal access token
GET   /integrations/figma/settings        — Get settings + Figma user info
PATCH /integrations/figma/settings        — Update settings
GET   /integrations/figma/preview?url=... — Fetch single file metadata
POST  /integrations/figma/batch-preview   — Fetch metadata for multiple URLs
```

All require Clerk JWT + workspace context. Connect/settings require ADMIN/OWNER. Preview endpoints are available to any workspace member.

---

## Connect Flow

Figma uses a **personal access token**, not OAuth. The admin pastes the token in an inline form — no redirect.

### Connect Modal

```
┌──────────────────────────────────────────────────────────────┐
│  Connect Figma                                          [X]  │
│                                                              │
│  Paste a Figma personal access token to enable               │
│  design previews on issues and projects.                     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ (i) How to get a token                               │   │
│  │                                                      │   │
│  │ 1. Go to figma.com/developers                        │   │
│  │ 2. Scroll to Personal Access Tokens                  │   │
│  │ 3. Click "Generate new token"                        │   │
│  │ 4. Copy and paste it below                           │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Access Token *                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ figd_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx               │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│                              [Cancel]  [Connect Figma]       │
└──────────────────────────────────────────────────────────────┘
```

### Connect Request/Response

```typescript
// Request
POST /integrations/figma/connect
{ "accessToken": "figd_xxxxxxxxxxxxxxxx" }

// Success Response
{
  "success": true,
  "data": {
    "provider": "figma",
    "figmaUser": { "handle": "shaheer", "email": "shaheer@example.com" }
  }
}
```

### Connect Errors

| Error | Message |
|---|---|
| Invalid token | "Invalid Figma access token. Generate one at figma.com/developers → Personal Access Tokens." |

### Connect Handler

```typescript
const handleConnect = async (provider: string) => {
  if (provider === 'github' || provider === 'slack') {
    // OAuth redirect
    const result = await integrationService.connect(provider);
    window.location.href = result.authUrl;
    return;
  }
  if (provider === 'discord') {
    setShowDiscordConnectModal(true);
    return;
  }
  if (provider === 'figma') {
    setShowFigmaConnectModal(true);  // Inline token form
    return;
  }
};
```

---

## Settings Panel

Figma has only 2 settings — much simpler than Slack/Discord.

```
┌──────────────────────────────────────────────────────────────┐
│  Figma Settings                                         [X]  │
│                                                              │
│  Display                                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Show design thumbnails on issues              [✓]   │   │
│  │ Show last modified date                       [✓]   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Connection                                                  │
│  Connected by Shaheer · Jun 13, 2026                         │
│  Figma user: @shaheer                                        │
│                                                              │
│  [Disconnect Figma]                                          │
└──────────────────────────────────────────────────────────────┘
```

### Settings Request/Response

```typescript
// GET /integrations/figma/settings
{
  "success": true,
  "data": {
    "settings": { "showThumbnails": true, "showLastModified": true },
    "figmaUser": { "handle": "shaheer", "email": "shaheer@example.com" }
  }
}

// PATCH /integrations/figma/settings
{ "showThumbnails": false }
```

---

## Design Preview — The Main Feature

### Single File Preview

When a user pastes a Figma URL in an issue, the frontend fetches a preview.

```typescript
// GET /integrations/figma/preview?url=https://www.figma.com/file/ABC123/Login-Flow

{
  "success": true,
  "data": {
    "fileKey": "ABC123",
    "name": "Login Flow",
    "thumbnailUrl": "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/...",
    "lastModified": "2026-06-10T14:30:00Z",
    "version": "123456789",
    "editorType": "figma",
    "nodeId": null,
    "url": "https://www.figma.com/file/ABC123/Login-Flow"
  }
}
```

If the URL includes a `?node-id=0-1` parameter, the backend fetches a node-specific thumbnail (higher quality, exact frame).

### Batch Preview

When loading an issue or project page with multiple Figma links, fetch all at once:

```typescript
// POST /integrations/figma/batch-preview
{ "urls": [
    "https://www.figma.com/file/ABC123/Login-Flow",
    "https://www.figma.com/file/DEF456/Checkout-Flow",
    "https://www.figma.com/file/ABC123/Login-Flow?node-id=0-1"
  ]
}

// Response — deduplicated by file key (ABC123 fetched once, not twice)
{
  "success": true,
  "data": [
    {
      "url": "https://www.figma.com/file/ABC123/Login-Flow",
      "fileKey": "ABC123",
      "name": "Login Flow",
      "thumbnailUrl": "https://...",
      "lastModified": "2026-06-10T14:30:00Z"
    },
    {
      "url": "https://www.figma.com/file/DEF456/Checkout-Flow",
      "fileKey": "DEF456",
      "name": "Checkout Flow",
      "thumbnailUrl": "https://...",
      "lastModified": "2026-06-08T09:00:00Z"
    },
    {
      "url": "https://www.figma.com/file/ABC123/Login-Flow?node-id=0-1",
      "fileKey": "ABC123",
      "name": "Login Flow",
      "thumbnailUrl": "https://...",
      "lastModified": "2026-06-10T14:30:00Z"
    }
  ]
}
```

Maximum 20 URLs per batch request.

---

## Where Figma Previews Appear

### 1. Issue Detail Page — Design Section

When an issue has Figma URLs in its description or `integrationRef`, show a Design section:

```
┌──────────────────────────────────────────────────────────────┐
│  Design                                                      │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  ┌───────────┐                                         │ │
│  │  │           │  Login Flow                             │ │
│  │  │ Thumbnail │  Last modified: Jun 10, 2026            │ │
│  │  │  Preview  │  Figma · figma                          │ │
│  │  │           │                                         │ │
│  │  └───────────┘  [Open in Figma ↗]                     │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  ┌───────────┐                                         │ │
│  │  │           │  Checkout Flow                          │ │
│  │  │ Thumbnail │  Last modified: Jun 8, 2026             │ │
│  │  │  Preview  │  Figma · figma                          │ │
│  │  │           │                                         │ │
│  │  └───────────┘  [Open in Figma ↗]                     │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Rules:**
- Only show this section if the issue has Figma URLs
- Use `batch-preview` endpoint on page load (not one request per URL)
- Clicking "Open in Figma" opens the original URL in a new tab
- Thumbnails are loaded from Figma's CDN URL (returned by the API)
- If Figma is not connected, show a subtle hint: "Connect Figma to see design previews"

### 2. Project Page — Designs Tab

Show all Figma files linked to issues in this project:

```
┌──────────────────────────────────────────────────────────────┐
│  Project: Mobile App > Designs                               │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │            │  │            │  │            │            │
│  │  Login     │  │  Checkout  │  │  Dashboard │            │
│  │  Flow      │  │  Flow      │  │  Screens   │            │
│  │            │  │            │  │            │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│  Modified 2d ago  Modified 1w ago Modified 3d ago            │
└──────────────────────────────────────────────────────────────┘
```

### 3. Inline URL Unfurling

When a user pastes a Figma URL in the issue description editor, auto-detect it and show an inline preview:

```typescript
// Detect Figma URLs in text
const FIGMA_URL_REGEX = /https?:\/\/(www\.)?figma\.com\/(file|design|proto|board)\/[a-zA-Z0-9]+/g;

function detectFigmaUrls(text: string): string[] {
  return [...(text.match(FIGMA_URL_REGEX) ?? [])];
}
```

---

## Frontend Types

```typescript
interface FigmaPreview {
  fileKey: string;
  name: string;
  thumbnailUrl: string;
  lastModified: string;
  version?: string;
  editorType?: string;
  nodeId?: string | null;
  url: string;
}

interface FigmaSettings {
  showThumbnails: boolean;
  showLastModified: boolean;
}

interface FigmaSettingsResponse {
  settings: FigmaSettings;
  figmaUser: { handle: string; email: string } | null;
}

interface ConnectFigmaInput {
  accessToken: string;
}
```

## Frontend Service

```typescript
export const figmaService = {
  connect: async (input: ConnectFigmaInput) => {
    const { data } = await privateApi.post('/integrations/figma/connect', input, {
      skipGlobalErrorToast: true,
    } as any);
    return data.data;
  },

  getSettings: async () => {
    const { data } = await privateApi.get('/integrations/figma/settings');
    return data.data as FigmaSettingsResponse;
  },

  updateSettings: async (settings: Partial<FigmaSettings>) => {
    const { data } = await privateApi.patch('/integrations/figma/settings', settings);
    return data.data;
  },

  preview: async (url: string) => {
    const { data } = await privateApi.get('/integrations/figma/preview', {
      params: { url },
    });
    return data.data as FigmaPreview;
  },

  batchPreview: async (urls: string[]) => {
    const { data } = await privateApi.post('/integrations/figma/batch-preview', { urls });
    return data.data as FigmaPreview[];
  },
};
```

---

## React Query Hooks

```typescript
// Query keys
const figmaQueryKeys = {
  settings: (workspaceId: string | undefined) =>
    ['integrations', 'figma', 'settings', workspaceId] as const,
  preview: (workspaceId: string | undefined, url: string) =>
    ['integrations', 'figma', 'preview', workspaceId, url] as const,
};

// Settings hook
export const useFigmaSettings = () => {
  const workspaceId = useAuthStore((s) => s.workspace?.id);
  return useQuery({
    queryKey: figmaQueryKeys.settings(workspaceId),
    queryFn: figmaService.getSettings,
    enabled: Boolean(workspaceId),
  });
};

// Single preview hook (for individual URL unfurling)
export const useFigmaPreview = (url: string, enabled = true) => {
  const workspaceId = useAuthStore((s) => s.workspace?.id);
  return useQuery({
    queryKey: figmaQueryKeys.preview(workspaceId, url),
    queryFn: () => figmaService.preview(url),
    enabled: Boolean(workspaceId) && enabled && isFigmaUrl(url),
    staleTime: 5 * 60 * 1000, // 5 min — Figma data doesn't change frequently
    retry: 1,
  });
};

// Connect mutation
export const useConnectFigma = () => {
  const queryClient = useQueryClient();
  const workspaceId = useAuthStore((s) => s.workspace?.id);
  return useMutation({
    mutationFn: figmaService.connect,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      queryClient.invalidateQueries({ queryKey: figmaQueryKeys.settings(workspaceId) });
    },
  });
};

// Update settings mutation
export const useUpdateFigmaSettings = () => {
  const queryClient = useQueryClient();
  const workspaceId = useAuthStore((s) => s.workspace?.id);
  return useMutation({
    mutationFn: figmaService.updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: figmaQueryKeys.settings(workspaceId) });
    },
  });
};
```

---

## Disconnect Confirmation

```
┌──────────────────────────────────────────────────────────────┐
│  Disconnect Figma                                            │
│                                                              │
│  Are you sure? This will:                                    │
│  • Remove design previews from all issues                    │
│  • Remove your Figma access token                            │
│  • Remove display settings                                   │
│                                                              │
│  Your Figma files and designs will not be affected.          │
│  You can reconnect anytime with a new token.                 │
│                                                              │
│                              [Cancel]  [Disconnect]          │
└──────────────────────────────────────────────────────────────┘
```

---

## Error Handling

| Code | Status | Frontend Action |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Invalid token or URL — show inline field error |
| `INTEGRATION_NOT_CONNECTED` | 404 | Show "Connect Figma to see design previews" hint |
| `NOT_FOUND` | 404 | File not found — show URL as plain link with "Preview unavailable" |
| Rate limited (429 from backend) | 429 | Show toast: "Too many requests, please wait" |

---

## PROVIDER_META Update

```typescript
figma: {
  id: 'figma',
  name: 'Figma',
  description: 'Link design files to issues. See thumbnails and metadata inline.',
  logo: 'https://cdn-icons-png.flaticon.com/512/5968/5968705.png',
  available: true,  // Changed from false
},
```

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Figma not connected, user pastes URL | Show hint: "Connect Figma to see design previews" |
| Invalid token on connect | 400: "Invalid Figma access token" |
| Token expired/revoked after connect | Preview returns null — show fallback: file name from URL, "Preview unavailable" |
| File not found (deleted in Figma) | 404: "Figma file not found or access denied" — show URL as plain link |
| Private file without access | Same 404 — token must have access to the file |
| URL with node-id | Backend fetches node-specific thumbnail (higher quality) |
| Batch preview with 20+ URLs | 400: "Maximum 20 URLs per batch request" |
| Same file linked from multiple URLs | Deduplicated by file key — only one API call |
| Non-Figma URL passed to preview | 400: "Not a valid Figma URL" |
| `figma.com/proto/` URL | Supported — prototype links work |
| `figma.com/board/` URL | Supported — FigJam board links work |
| `figma.com/design/` URL | Supported — new design URL format |

---

## Implementation Order

1. **Update `PROVIDER_META`** — set `figma.available = true`
2. **Build `FigmaConnectModal`** — access token input form
3. **Update connect handler** — show modal for Figma
4. **Build `FigmaSettingsPanel`** — 2 toggles + Figma user info
5. **Build `FigmaPreviewCard`** — thumbnail, name, last modified, "Open in Figma" link
6. **Add Design section to issue detail** — detect Figma URLs, call batch-preview, render cards
7. **Add inline URL detection** — auto-detect Figma URLs in issue description editor
8. **Test** — connect, preview, batch preview, disconnect

---

## Done When

- [ ] Figma card shows "Connect" with inline token form (no OAuth)
- [ ] Token validated against Figma API on connect
- [ ] Connected state shows Figma user handle
- [ ] Settings panel shows 2 toggles
- [ ] `GET /preview?url=...` returns file name, thumbnail, last modified
- [ ] `POST /batch-preview` fetches multiple files, deduplicated by file key
- [ ] Issue detail shows Design section with Figma preview cards
- [ ] Preview cards show thumbnail, name, last modified, "Open in Figma" link
- [ ] Node-specific thumbnails work for URLs with `?node-id=`
- [ ] Figma not connected → shows connect hint instead of previews
- [ ] Expired/revoked token → graceful fallback, no crash
- [ ] Disconnect clears token and settings
