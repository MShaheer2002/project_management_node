# Phase 18 — API Keys: Frontend Integration Guide

Backend references:
- [phase18-api-keys-guide.md](./phase18-api-keys-guide.md)
- [modules/api-key/api-key.routes.ts](../../modules/api-key/api-key.routes.ts)
- [modules/api-key/api-key.schemas.ts](../../modules/api-key/api-key.schemas.ts)
- [modules/api-key/api-key.service.ts](../../modules/api-key/api-key.service.ts)

Frontend files impacted:
- [ApiKeysPage.tsx](</Users/shaheer/Documents/personal/project_management_react/src/pages/ApiKeysPage.tsx>)
- [types.ts](</Users/shaheer/Documents/personal/project_management_react/src/types.ts>)
- [workspace.ts](</Users/shaheer/Documents/personal/project_management_react/src/shared/permissions/workspace.ts>)
- [constants.ts](</Users/shaheer/Documents/personal/project_management_react/src/constants.ts>) — remove MOCK_API_KEYS

Recommended new frontend area:

```txt
src/features/api-keys/
├── services/apiKeyService.ts
├── hooks/useApiKeyData.ts
├── hooks/useApiKeyMutations.ts
├── types.ts
└── components/
    ├── CreateApiKeyModal.tsx
    └── RevokeApiKeyDialog.tsx
```

## Preconditions

- authenticated frontend flow is stable
- `privateApi` is already injecting `Authorization` and `X-Workspace-Id`
- the `/api-keys` route is already defined in `routes.tsx` with admin role guard
- sidebar "API Keys" link is already rendered and guarded by `canManageApiKeys`
- `ApiKeysPage.tsx` exists with mock data — needs migration to real API calls

## Backend Routes To Use

```txt
POST   /api-keys        — Create API key (returns raw key ONCE)
GET    /api-keys         — List all keys in workspace (masked prefixes)
GET    /api-keys/:id     — Get single key details (masked)
DELETE /api-keys/:id     — Revoke key (immediate, 204)
```

All routes require:
- Clerk JWT authentication (NOT API key — you cannot manage keys with a key)
- Active workspace context (`X-Workspace-Id` header)
- `ADMIN` or `OWNER` role

## Important Backend Behavior

- raw key is returned ONLY in the `POST /api-keys` response — it is never stored on the server
- `GET` responses contain `keyPrefix` (first 16 chars) for display, never the full key
- there is no "reveal" endpoint — the full key cannot be recovered after creation
- if a user loses their key, they must delete and create a new one
- revocation is immediate — the key stops working on the next request
- `lastUsedAt` is updated with a 5-minute debounce on the server (not real-time)
- expired keys remain in the list with `isExpired: true` until explicitly deleted
- plan limits: FREE = 2 keys, STANDARD = 10, PREMIUM = 50

Frontend rule:

- only `owner` and `admin` can access the API Keys page and all its actions
- the full raw key must ONLY be shown in the post-creation modal — never anywhere else
- copy button on key cards copies the prefix only, not the full key

## Types

### Existing Type (already correct)

The `ApiKey` type in `src/types.ts` already matches the backend list response:

```typescript
export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  isExpired: boolean;
  createdBy: {
    id: string;
    name: string;
    email: string;
  };
}
```

No change needed.

### New Types

Add these in `src/features/api-keys/types.ts`:

```typescript
import type { ApiKey } from '@/types';

/** POST /api-keys response — includes full raw key (shown ONCE) */
export interface ApiKeyCreateResponse extends ApiKey {
  key: string; // Full raw key — lin_live_... or lin_test_...
}

/** POST /api-keys request body */
export interface CreateApiKeyInput {
  name: string;            // 1-100 chars, required
  expiresAt?: string;      // ISO 8601, optional, must be in the future
}
```

## Service Contract

```typescript
// src/features/api-keys/services/apiKeyService.ts

import { privateApi } from '@shared/services/privateApi';
import type { ApiResponse } from '@shared/services/types';
import type { ApiKey } from '@/types';
import type { ApiKeyCreateResponse, CreateApiKeyInput } from '../types';
import type { AxiosRequestConfig } from 'axios';

export const apiKeyService = {
  /** GET /api-keys — List all keys (masked prefixes) */
  list: async (): Promise<ApiKey[]> => {
    const { data } = await privateApi.get<ApiResponse<ApiKey[]>>('/api-keys');
    return data.data;
  },

  /** GET /api-keys/:id — Get single key details (masked) */
  getById: async (id: string): Promise<ApiKey> => {
    const { data } = await privateApi.get<ApiResponse<ApiKey>>(`/api-keys/${id}`);
    return data.data;
  },

  /** POST /api-keys — Create key (returns raw key ONCE) */
  create: async (input: CreateApiKeyInput): Promise<ApiKeyCreateResponse> => {
    const { data } = await privateApi.post<ApiResponse<ApiKeyCreateResponse>>(
      '/api-keys',
      input,
      { skipGlobalErrorToast: true } as AxiosRequestConfig & { skipGlobalErrorToast: boolean },
    );
    return data.data;
  },

  /** DELETE /api-keys/:id — Revoke key (immediate) */
  revoke: async (id: string): Promise<void> => {
    await privateApi.delete(`/api-keys/${id}`, {
      skipGlobalErrorToast: true,
    } as AxiosRequestConfig & { skipGlobalErrorToast: boolean });
  },
};
```

## Query Keys and Hooks

```typescript
// src/features/api-keys/hooks/useApiKeyData.ts

import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/app/stores/useAuthStore';
import { apiKeyService } from '../services/apiKeyService';

export const apiKeyQueryKeys = {
  all: ['api-keys'] as const,
  list: (workspaceId: string | undefined) =>
    [...apiKeyQueryKeys.all, 'list', workspaceId] as const,
  detail: (workspaceId: string | undefined, id: string) =>
    [...apiKeyQueryKeys.all, 'detail', workspaceId, id] as const,
};

export const useApiKeys = () => {
  const workspaceId = useAuthStore((s) => s.workspace?.id);
  return useQuery({
    queryKey: apiKeyQueryKeys.list(workspaceId),
    queryFn: apiKeyService.list,
    enabled: Boolean(workspaceId),
  });
};
```

```typescript
// src/features/api-keys/hooks/useApiKeyMutations.ts

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/app/stores/useAuthStore';
import { useToastStore } from '@/app/stores/useToastStore';
import { apiKeyService } from '../services/apiKeyService';
import { apiKeyQueryKeys } from './useApiKeyData';
import type { CreateApiKeyInput } from '../types';

export const useCreateApiKey = () => {
  const queryClient = useQueryClient();
  const workspaceId = useAuthStore((s) => s.workspace?.id);

  return useMutation({
    mutationFn: (input: CreateApiKeyInput) => apiKeyService.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: apiKeyQueryKeys.list(workspaceId),
      });
    },
  });
};

export const useRevokeApiKey = () => {
  const queryClient = useQueryClient();
  const workspaceId = useAuthStore((s) => s.workspace?.id);
  const showToast = useToastStore((s) => s.showToast);

  return useMutation({
    mutationFn: (id: string) => apiKeyService.revoke(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: apiKeyQueryKeys.list(workspaceId),
      });
      showToast('API key revoked', 'success');
    },
  });
};
```

## Permission Helper

Add to `src/shared/permissions/workspace.ts`:

```typescript
export const canManageApiKeys = (role: WorkspaceRoleInput): boolean =>
  role === 'owner' || role === 'admin';
```

## Migration from Mock Data

### Step 1: Replace Data Source

In `ApiKeysPage.tsx`, replace:

```typescript
// OLD
import { MOCK_API_KEYS } from '../constants';

const activeKeys = MOCK_API_KEYS.filter((k) => !k.isExpired);
const expiredKeys = MOCK_API_KEYS.filter((k) => k.isExpired);
```

With:

```typescript
// NEW
import { useApiKeys } from '@features/api-keys/hooks/useApiKeyData';

const { data: apiKeys = [], isLoading } = useApiKeys();

const activeKeys = apiKeys.filter((k) => !k.isExpired);
const expiredKeys = apiKeys.filter((k) => k.isExpired);
```

### Step 2: Replace Delete Handler

Replace the mock delete with the real mutation:

```typescript
import { useRevokeApiKey } from '@features/api-keys/hooks/useApiKeyMutations';

const revokeApiKey = useRevokeApiKey();

const handleDelete = (apiKey: ApiKey) => {
  // Show confirmation dialog first (see Revoke Dialog section below)
  revokeApiKey.mutate(apiKey.id);
};
```

### Step 3: Replace AppContext with Zustand

The current page imports from `useApp()` (legacy context). Replace:

```typescript
// OLD
import { useApp } from '../AppContext';
const { setActiveModal, showToast } = useApp();

// NEW
import { useToastStore } from '@/app/stores/useToastStore';
const showToast = useToastStore((s) => s.showToast);
```

### Step 4: Update Key Count Badge

```typescript
// OLD
{MOCK_API_KEYS.length}

// NEW
{apiKeys.length}
```

### Step 5: Add Loading State

Add a loading skeleton before the key list renders:

```typescript
{isLoading ? (
  <div className="space-y-3">
    {[1, 2].map((i) => (
      <div key={i} className="rounded-xl border border-gray-200 dark:border-border-dark p-5 animate-pulse">
        <div className="h-4 bg-gray-200 dark:bg-white/[0.06] rounded w-40 mb-3" />
        <div className="h-3 bg-gray-100 dark:bg-white/[0.04] rounded w-60" />
      </div>
    ))}
  </div>
) : (
  /* existing key list */
)}
```

### Step 6: Remove MOCK_API_KEYS

Delete the `MOCK_API_KEYS` constant from `src/constants.ts` after the migration.

## Create API Key Modal

This is a two-step modal. Step 1 collects input, Step 2 shows the raw key once.

### Step 1 — Input Form

```
┌─────────────────────────────────────────────────────────────┐
│  Generate New API Key                                  [X]  │
│                                                             │
│  Name *                                                     │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ CI/CD Pipeline                                      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  Expiration                                                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Never                                          [v]  │    │
│  └─────────────────────────────────────────────────────┘    │
│  Options: Never, 30 days, 60 days, 90 days, 1 year, Custom │
│                                                             │
│                              [Cancel]  [Generate Key]       │
└─────────────────────────────────────────────────────────────┘
```

On submit: call `useCreateApiKey().mutate(input)`.

Expiration options should compute ISO 8601 dates:

```typescript
const EXPIRY_OPTIONS = [
  { label: 'Never', value: undefined },
  { label: '30 days', value: () => addDays(new Date(), 30).toISOString() },
  { label: '60 days', value: () => addDays(new Date(), 60).toISOString() },
  { label: '90 days', value: () => addDays(new Date(), 90).toISOString() },
  { label: '1 year', value: () => addDays(new Date(), 365).toISOString() },
  // Custom: show date picker
];
```

### Step 2 — One-Time Key Display

After successful creation, the modal transitions to this view:

```
┌─────────────────────────────────────────────────────────────┐
│  Your API key has been created                              │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ lin_live_a8f3bc91e4d7f02b1c9a3e5d7f8b0c2a4e6f8d0   │    │
│  │ b2c4a6e8f0d2b4c6a8e0f                          [Copy]│   │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ⚠ Copy this key now. You won't be able to see it again.  │
│  Store it securely in an environment variable or            │
│  password manager.                                          │
│                                                             │
│  Example usage:                                             │
│  curl -H "Authorization: Bearer lin_live_a8f3..."           │
│       http://localhost:8000/issues                           │
│                                                             │
│                                 [I've copied the key]       │
└─────────────────────────────────────────────────────────────┘
```

Rules for Step 2:

- modal CANNOT be closed by clicking outside or pressing Escape
- only the "I've copied the key" button closes it
- the Copy button shows checkmark + "Copied!" feedback for 2 seconds
- key is displayed in monospace font with `break-all` so it wraps
- the curl example uses the actual generated key
- after closing, the key list refreshes automatically (invalidation already handled by mutation)

Implementation pattern:

```typescript
const [step, setStep] = useState<'input' | 'created'>('input');
const [createdKey, setCreatedKey] = useState<string | null>(null);

const createApiKey = useCreateApiKey();

const handleSubmit = async (input: CreateApiKeyInput) => {
  const result = await createApiKey.mutateAsync(input);
  setCreatedKey(result.key);
  setStep('created');
};

const handleDone = () => {
  setCreatedKey(null);
  setStep('input');
  onClose(); // close modal
};
```

## Revoke Confirmation Dialog

```
┌─────────────────────────────────────────────────────────────┐
│  Revoke API Key                                             │
│                                                             │
│  Are you sure you want to revoke "{name}"?                  │
│  ({keyPrefix})                                              │
│                                                             │
│  This action is immediate and cannot be undone. Any         │
│  integration using this key will stop working instantly.    │
│                                                             │
│                              [Cancel]  [Revoke Key]         │
└─────────────────────────────────────────────────────────────┘
```

- "Revoke Key" button must be red/destructive styled
- disable button while mutation is pending
- on success: dialog closes, list refreshes, toast shown

## Error Handling

Map these backend codes to frontend behavior:

| Code | Status | Frontend Action |
|------|--------|----------------|
| `API_KEY_LIMIT_REACHED` | 409 | Show in create modal: "You've reached the maximum number of API keys for your plan. Delete unused keys or upgrade." |
| `API_KEY_NOT_FOUND` | 404 | Refetch list, show toast: "This API key no longer exists." |
| `INSUFFICIENT_ROLE` | 403 | Should not happen (route is already guarded). Show toast if it does. |
| `VALIDATION_ERROR` | 422 | Map field errors to form: `name` or `expiresAt` |

Create modal error handling:

```typescript
const handleSubmit = async (input: CreateApiKeyInput) => {
  try {
    const result = await createApiKey.mutateAsync(input);
    setCreatedKey(result.key);
    setStep('created');
  } catch (err) {
    const apiError = err as ApiAxiosError;
    const code = apiError.response?.data?.error?.code;
    const message = apiError.response?.data?.error?.message;

    if (code === 'API_KEY_LIMIT_REACHED') {
      setError(message || "You've reached the maximum API keys for your plan.");
    } else if (code === 'VALIDATION_ERROR') {
      // Map field errors
      const details = apiError.response?.data?.error?.details;
      if (details?.name) setNameError(details.name[0]);
      if (details?.expiresAt) setExpiryError(details.expiresAt[0]);
    } else {
      setError(message || 'Could not create API key.');
    }
  }
};
```

Revoke error handling:

```typescript
revokeApiKey.mutate(apiKey.id, {
  onError: (err) => {
    const code = (err as ApiAxiosError).response?.data?.error?.code;
    if (code === 'API_KEY_NOT_FOUND') {
      showToast('This API key no longer exists.', 'info');
      queryClient.invalidateQueries({ queryKey: apiKeyQueryKeys.list(workspaceId) });
    } else {
      showToast('Could not revoke API key.', 'error');
    }
  },
});
```

## Copy Behavior

The current page already correctly copies the prefix only — keep this behavior:

```typescript
const handleCopyPrefix = (apiKey: ApiKey) => {
  navigator.clipboard.writeText(apiKey.keyPrefix);
  setCopiedId(apiKey.id);
  setTimeout(() => setCopiedId(null), 2000);
  showToast('Key prefix copied to clipboard', 'success');
};
```

The full key copy only happens in the create modal (Step 2):

```typescript
const handleCopyFullKey = () => {
  if (!createdKey) return;
  navigator.clipboard.writeText(createdKey);
  setKeyCopied(true);
  setTimeout(() => setKeyCopied(false), 2000);
};
```

## What the Current Mock Already Gets Right

These elements from `ApiKeysPage.tsx` are correct and should be kept:

- header with key count badge + "Generate New Key" button
- security notice banner with lost-key guidance
- key cards with name, created date, last used, expiry, created by
- masked prefix display with `••••••••••••••••` placeholder
- copy prefix button (not full key)
- delete (trash) icon on hover
- expired keys section with muted styling + "Expired" badge
- empty state with icon, copy, and CTA button
- `formatRelativeTime` and `formatDate` helpers

## What the Current Mock Gets Wrong

| Issue | Fix |
|---|---|
| Uses `MOCK_API_KEYS` from constants | Replace with `useApiKeys()` hook |
| Uses `useApp()` from legacy context | Replace with `useToastStore` + state hooks |
| Uses `setActiveModal('generate-api-key')` | Replace with local `useState` for modal open/close, or keep modal registry if project uses one |
| Delete handler is a no-op with `setTimeout` | Replace with `useRevokeApiKey()` mutation |
| No loading state | Add skeleton loader |
| No error state | Add error message with retry |
| No create modal implementation | Build the two-step `CreateApiKeyModal` |
| No revoke confirmation dialog | Build `RevokeApiKeyDialog` |

## Implementation Order

1. **Create service** — `apiKeyService.ts` with list, create, revoke methods
2. **Create types** — `ApiKeyCreateResponse`, `CreateApiKeyInput`
3. **Create hooks** — `useApiKeys`, `useCreateApiKey`, `useRevokeApiKey`
4. **Add permission helper** — `canManageApiKeys` in `workspace.ts`
5. **Build CreateApiKeyModal** — two-step modal with one-time key display
6. **Build RevokeApiKeyDialog** — confirmation with destructive action
7. **Migrate ApiKeysPage** — replace mock data with hooks, add loading/error states
8. **Remove MOCK_API_KEYS** — clean up constants file
9. **Test** — full flow: create key, copy from modal, see it in list (masked), revoke, verify error states

## Done When

- [ ] API keys page loads real data from `GET /api-keys`
- [ ] "Generate New Key" opens create modal with name + expiry inputs
- [ ] After creation, raw key is shown ONCE in the modal with copy button
- [ ] Modal cannot be dismissed without clicking "I've copied the key"
- [ ] Key list shows masked prefixes — never the full key
- [ ] Copy button on cards copies prefix only
- [ ] Revoke shows confirmation dialog, then deletes immediately
- [ ] Expired keys displayed with muted styling and "Expired" badge
- [ ] Loading skeleton shown while fetching
- [ ] Empty state shown when no keys exist
- [ ] Plan limit error shown when max keys reached
- [ ] `MOCK_API_KEYS` removed from codebase
- [ ] Page only accessible to `ADMIN` and `OWNER` roles
