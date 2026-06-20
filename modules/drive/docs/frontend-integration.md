# Google Drive Integration — Frontend Integration Guide

> This document describes how the React frontend should integrate with the Drive backend APIs.
> It covers the full flow: checking connection status, OAuth, file upload, and displaying attachments.

---

## 1. Architecture Overview

```
┌─────────────────────┐     ┌─────────────────────────┐     ┌──────────────────┐
│   React Frontend    │     │   Trussen Backend       │     │  Google Drive API │
│                     │     │                          │     │                  │
│  1. Check status ───┼────►│  GET /me/drive           │     │                  │
│                     │◄────┼── { connected, email }   │     │                  │
│                     │     │                          │     │                  │
│  2. Connect  ───────┼────►│  POST /me/drive/connect  │     │                  │
│                     │◄────┼── { authUrl }            │     │                  │
│  3. Open authUrl ───┼─────┼──────────────────────────┼────►│  OAuth consent   │
│                     │     │  GET /me/drive/callback ◄┼─────┼── redirect       │
│                     │◄────┼── redirect to frontend   │     │                  │
│                     │     │                          │     │                  │
│  4. Upload file ────┼────►│  POST /me/drive/upload-url│    │                  │
│                     │◄────┼── { uploadUrl, token }   │     │                  │
│  5. PUT bytes ──────┼─────┼──────────────────────────┼────►│  resumable upload│
│                     │◄────┼──────────────────────────┼─────┼── file metadata  │
│                     │     │                          │     │                  │
│  6. Save link ──────┼────►│  (existing attachment API)│    │                  │
└─────────────────────┘     └─────────────────────────┘     └──────────────────┘
```

**Key principle:** File bytes NEVER touch our backend. Frontend uploads directly to Google Drive.

---

## 2. API Reference

### 2.1 Check Connection Status

```typescript
// GET /me/drive
// Headers: Authorization: Bearer <clerk_token>

// Response (connected):
{
  "success": true,
  "data": {
    "connected": true,
    "email": "shaheer@gmail.com",
    "provider": "google_drive",
    "connectedAt": "2025-01-15T10:30:00.000Z"
  }
}

// Response (not connected):
{
  "success": true,
  "data": {
    "connected": false,
    "email": null,
    "provider": null
  }
}
```

### 2.2 Start OAuth Flow

```typescript
// POST /me/drive/connect
// Headers: Authorization: Bearer <clerk_token>

// Response:
{
  "success": true,
  "data": {
    "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?client_id=...&scope=..."
  }
}
```

**Frontend opens `authUrl` in a popup or redirect.** After consent, Google redirects to `/me/drive/callback`, which exchanges the code for tokens and redirects back to the frontend:

```
→ Success: /settings?tab=integrations&provider=drive&status=connected
→ Error:   /settings?tab=integrations&provider=drive&status=error&message=...
```

### 2.3 Disconnect

```typescript
// DELETE /me/drive/disconnect
// Headers: Authorization: Bearer <clerk_token>

// Response: 204 No Content
```

### 2.4 Get Upload URL

```typescript
// POST /me/drive/upload-url
// Headers: Authorization: Bearer <clerk_token>

// Request body:
{
  "fileName": "design-spec.pdf",
  "mimeType": "application/pdf",
  "folderId": "1abc..."  // optional — Drive folder ID
}

// Response:
{
  "success": true,
  "data": {
    "uploadUrl": "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=...",
    "accessToken": "ya29.a0AfH6SMB..."  // short-lived token for upload
  }
}
```

---

## 3. Frontend Upload Flow (Step-by-Step)

### 3.1 Complete Upload Function

```typescript
interface DriveUploadResult {
  driveFileId: string;
  driveUrl: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

async function uploadToDrive(
  file: File,
  apiClient: AxiosInstance,
): Promise<DriveUploadResult> {
  // Step 1: Get resumable upload URL from our backend
  const { data } = await apiClient.post("/me/drive/upload-url", {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
  });

  const { uploadUrl, accessToken } = data.data;

  // Step 2: Upload file bytes directly to Google Drive
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": file.type || "application/octet-stream",
      "Content-Length": String(file.size),
    },
    body: file,
  });

  if (!uploadResponse.ok) {
    throw new Error("Failed to upload file to Google Drive");
  }

  const driveFile = await uploadResponse.json() as {
    id: string;
    name: string;
    mimeType: string;
    size: string;
    webViewLink: string;
  };

  // Step 3: Make the file shareable (anyone with link can view)
  await fetch(
    `https://www.googleapis.com/drive/v3/files/${driveFile.id}/permissions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "reader",
        type: "anyone",
      }),
    },
  );

  return {
    driveFileId: driveFile.id,
    driveUrl: driveFile.webViewLink ?? `https://drive.google.com/file/d/${driveFile.id}/view`,
    fileName: driveFile.name,
    mimeType: driveFile.mimeType,
    sizeBytes: parseInt(driveFile.size, 10),
  };
}
```

### 3.2 Using the Upload Result

After uploading, pass the metadata to your existing attachment/issue API:

```typescript
// Example: Attach to an issue
const result = await uploadToDrive(file, apiClient);

await apiClient.post(`/issues/${issueId}/attachments`, {
  key: result.driveFileId,
  fileName: result.fileName,
  contentType: result.mimeType,
  size: result.sizeBytes,
  kind: "attachment",
  assetUrl: result.driveUrl,  // The Drive shareable link
});
```

---

## 4. Suggested React Components

### 4.1 Component Structure

```
src/features/drive/
├── components/
│   ├── DriveConnectButton.tsx        # Connect/disconnect toggle
│   ├── DriveUploader.tsx             # File picker + upload with progress
│   └── DriveAttachmentItem.tsx       # Renders a Drive file link with icon
├── hooks/
│   ├── useDriveConnection.ts         # Connection status query
│   ├── useDriveConnect.ts            # Connect mutation (open OAuth popup)
│   ├── useDriveDisconnect.ts         # Disconnect mutation
│   └── useDriveUpload.ts            # Upload mutation with progress
└── services/
    └── driveService.ts               # API calls
```

### 4.2 Hook Examples

```typescript
// useDriveConnection.ts
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";

export function useDriveConnection() {
  return useQuery({
    queryKey: ["drive", "connection"],
    queryFn: async () => {
      const { data } = await api.get("/me/drive");
      return data.data;
    },
  });
}
```

```typescript
// useDriveConnect.ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";

export function useDriveConnect() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post("/me/drive/connect");
      return data.data.authUrl;
    },
    onSuccess: (authUrl) => {
      // Open OAuth consent in a popup
      const popup = window.open(authUrl, "drive-oauth", "width=500,height=700");

      // Poll for popup close (callback redirects back to our frontend)
      const interval = setInterval(() => {
        if (popup?.closed) {
          clearInterval(interval);
          queryClient.invalidateQueries({ queryKey: ["drive", "connection"] });
        }
      }, 500);
    },
  });
}
```

```typescript
// useDriveUpload.ts
import { useMutation } from "@tanstack/react-query";
import api from "@/lib/api";

interface UploadResult {
  driveFileId: string;
  driveUrl: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export function useDriveUpload() {
  return useMutation({
    mutationFn: async (file: File): Promise<UploadResult> => {
      // 1. Get upload URL from backend
      const { data } = await api.post("/me/drive/upload-url", {
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
      });

      const { uploadUrl, accessToken } = data.data;

      // 2. Upload directly to Google Drive
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
      });

      if (!uploadRes.ok) throw new Error("Upload failed");

      const driveFile = await uploadRes.json();

      // 3. Set sharing permissions
      await fetch(
        `https://www.googleapis.com/drive/v3/files/${driveFile.id}/permissions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ role: "reader", type: "anyone" }),
        },
      );

      return {
        driveFileId: driveFile.id,
        driveUrl: driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`,
        fileName: driveFile.name,
        mimeType: driveFile.mimeType,
        sizeBytes: parseInt(driveFile.size, 10),
      };
    },
  });
}
```

### 4.3 DriveConnectButton Component

```tsx
import { useDriveConnection } from "../hooks/useDriveConnection";
import { useDriveConnect } from "../hooks/useDriveConnect";
import { useDriveDisconnect } from "../hooks/useDriveDisconnect";

export function DriveConnectButton() {
  const { data: connection, isLoading } = useDriveConnection();
  const connect = useDriveConnect();
  const disconnect = useDriveDisconnect();

  if (isLoading) return <Skeleton />;

  if (connection?.connected) {
    return (
      <div>
        <span>Connected as {connection.email}</span>
        <Button
          variant="destructive"
          onClick={() => disconnect.mutate()}
          loading={disconnect.isPending}
        >
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <Button onClick={() => connect.mutate()} loading={connect.isPending}>
      Connect Google Drive
    </Button>
  );
}
```

---

## 5. Where to Add Drive Upload in Existing UI

| Location | How |
|---|---|
| **Issue creation form** | Add "Attach files" button that opens file picker → `useDriveUpload` → passes result to issue create payload |
| **Issue detail → attachments** | "Add attachment" button → same flow → `POST /issues/:id/attachments` with `assetUrl = driveUrl` |
| **Comments** | Inline attachment button → upload → embed Drive link in comment body |
| **Project/Team/Workspace docs** | "Upload document" button → upload → sets `fileUrl = driveUrl` on EntityDocument |

---

## 6. Error Handling

| Error Code | Meaning | Frontend Action |
|---|---|---|
| `DRIVE_NOT_CONFIGURED` | Server missing Google credentials | Show "Drive integration not available" |
| `DRIVE_NOT_CONNECTED` | User hasn't connected Drive | Show "Connect Google Drive" prompt |
| `DRIVE_ALREADY_CONNECTED` | User trying to connect again | Show current connection status |
| `DRIVE_OAUTH_FAILED` | OAuth flow failed | Show error message, offer retry |
| `DRIVE_TOKEN_REFRESH_FAILED` | Refresh token revoked/expired | Show "Reconnect Google Drive" prompt |

---

## 7. Security Notes

- **Never store `accessToken` in localStorage.** It's short-lived and fetched on-demand from `/me/drive/upload-url`.
- **The `accessToken` in the upload-url response is valid for ~60 minutes.** Use it immediately for the upload, then discard.
- **`VITE_GOOGLE_CLIENT_ID`** is safe to expose (it's a public identifier). The Client Secret is backend-only.
- **File sharing permissions** are set to "anyone with link can view" during upload. Users can change this in Google Drive directly.
