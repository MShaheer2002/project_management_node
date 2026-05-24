# S3 Signed View URL Guide

This guide explains how a private S3 bucket can still be viewed in the browser without making objects public.

## Goal

Keep the bucket private and use temporary signed URLs for read access.

This gives you:
- private storage
- workspace-scoped authorization
- temporary browser access
- no public object exposure

## Important Principle

Do **not** disable S3 Block Public Access for application files.

For a SaaS app like this one, attachments should stay private. The browser should never receive a permanent public S3 URL as the source of truth.

## How It Works

### Upload flow

1. Frontend requests a presigned `PUT` URL from backend.
2. Backend validates auth + workspace + file metadata.
3. Backend returns:
   - `uploadUrl`
   - `method: PUT`
   - `headers`
   - `key`
4. Frontend uploads directly to S3 using the presigned URL.
5. Backend stores only the object metadata and key.

### View flow

1. User clicks an attachment.
2. Frontend calls backend:

```http
GET /uploads/view-url?key=<storedKey>
```

3. Backend validates:
   - authenticated user
   - active workspace
   - key belongs to workspace prefix
4. Backend returns a short-lived presigned `GET` URL.
5. Frontend opens that URL in a new tab or uses it as the image/video src.

The signed `GET` URL expires after a short window, so access is temporary and controlled.

## What To Store In DB

Store stable metadata, not the signed URL:

```json
{
  "key": "uploads/workspaces/<workspaceId>/attachment/2026/05/file.png",
  "fileName": "Shot.png",
  "size": 2240573,
  "contentType": "image/png"
}
```

Do not store:
- the signed `PUT` URL
- the signed `GET` URL

Both expire.

## Backend Route

Implemented route:

```http
GET /uploads/view-url?key=...
```

Behavior:
- authenticated
- workspace-scoped
- rate limited
- returns signed `GET` URL only if the key matches the active workspace prefix

## Frontend Usage

Open the file in a new tab:

```ts
const response = await api.get("/uploads/view-url", {
  params: { key },
});

window.open(response.data.data.url, "_blank");
```

Or use it in a preview component:
- `<img src="signedUrl" />`
- `<video src="signedUrl" controls />`

## Security Notes

- Keep `Block all public access` enabled.
- Keep `Bucket owner enforced` enabled.
- Do not make attachment objects public.
- Do not send auth headers to S3 directly.
- The backend must validate the key prefix before signing a view URL.
- The signed URL should be short-lived.

## Recommended Expiry

- View URLs: 5 minutes
- Upload URLs: 15 minutes or as configured in `AWS_S3_URL_TTL_SECONDS`

## Why This Is Correct

This is the standard private-file SaaS pattern:
- backend controls authorization
- S3 stores objects privately
- browser only gets temporary access tokens in the form of signed URLs
- no permanent public access is required

## Done When

- [ ] Upload succeeds with presigned `PUT`
- [ ] View succeeds with presigned `GET`
- [ ] Bucket stays private
- [ ] Frontend can open attachments by key
- [ ] Access expires after the signed URL TTL
