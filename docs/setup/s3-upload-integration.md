# S3 Upload Integration Guide

> This guide explains how to configure AWS S3 for direct browser uploads and how to add `presigned-url` and `presigned-urls` endpoints to this backend.
> No source code snippets — this is a setup and implementation checklist.

---

## 1. Goal

The upload flow should work like this:

1. The frontend asks the backend for one or more presigned upload URLs.
2. The backend validates the request, generates S3 object keys, and signs S3 `PUT` URLs.
3. The frontend uploads files directly to S3.
4. After upload succeeds, the frontend calls the real domain endpoint to save the returned file URL or object key.

This keeps binary uploads out of Express and fits the current backend structure.

---

## 2. Required Environment Variables

These environment variables are required:

| Variable | Purpose |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM access key for S3 access |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key |
| `AWS_REGION` | AWS region of the bucket, for example `us-east-1` |
| `AWS_S3_BUCKET` | Bucket name |

Recommended optional variables:

| Variable | Purpose |
|---|---|
| `AWS_S3_URL_TTL_SECONDS` | Presigned URL expiry window |
| `AWS_S3_PUBLIC_BASE_URL` | Public CDN or bucket base URL if files are publicly readable |
| `UPLOAD_IMAGE_MAX_BYTES` | Central image size limit |
| `UPLOAD_VIDEO_MAX_BYTES` | Central video size limit |

In this repo, the backend should validate all required S3 variables in `config/env.ts` before the server starts.

---

## 3. AWS Bucket Setup

### 3.1 Create the Bucket

In AWS S3:

1. Open the S3 console.
2. Create a new bucket in the same region you plan to use in `AWS_REGION`.
3. Pick a stable bucket name.
4. Keep `ACLs disabled` and `Bucket owner enforced`.
5. Leave public access blocked unless you intentionally want public files.

Recommended defaults:

- versioning: optional but useful
- default encryption: enabled
- object ownership: bucket owner enforced

### 3.2 Decide Public vs Private Early

You need to decide this before frontend integration:

- **Private bucket**: safer default. Store object keys in your DB. Serve files later through signed read URLs or a CDN policy.
- **Public bucket/CDN**: simpler for avatars and logos. Store a public URL after upload.

For this project, private-by-default is the safer choice. If you only need workspace logos and avatars right now, a controlled public path can still be acceptable.

If you keep the bucket private, use temporary signed `GET` URLs for viewing:
- [S3 Signed View URL Guide](./s3-signed-view-url-guide.md)

### 3.3 Configure CORS on the Bucket

Your browser uploads will fail without bucket CORS.

Allow:

- frontend origins you actually use
- methods: `PUT`, `GET`, `HEAD`
- headers: `Content-Type`, `x-amz-*`
- exposed headers: `ETag`

Keep CORS narrow:

- allow localhost frontend origin in development
- allow your production frontend origin in production
- do not use `*` for origins if credentials or stricter control matter

### 3.4 Add Lifecycle Rules

Recommended lifecycle rules:

- clean up abandoned temporary prefixes if you later use draft uploads
- transition old large videos if storage cost matters
- expire incomplete multipart uploads if you later add multipart video uploads

---

## 4. IAM Setup

Do not use root credentials.

Create an IAM user or role with only the permissions this app needs.

Recommended permissions:

- `s3:PutObject`
- `s3:AbortMultipartUpload` if you later support multipart uploads
- `s3:ListBucket` only if your backend genuinely needs it
- `s3:GetObject` only if your backend needs direct reads

Scope access to:

- the specific bucket
- ideally only the prefixes your app writes to

Example prefix strategy:

- `workspaces/*`
- `users/*`
- `attachments/*`

Keep the credentials in the backend only. The frontend must never see AWS keys.

---

## 5. Where This Fits in the Repo

This codebase is structured around route, controller, schema, service, and shared infra helpers.

Recommended placement:

| Path | Responsibility |
|---|---|
| `config/env.ts` | validate S3 env vars |
| `infra/storage/` | S3 client, object key builder, signing helpers |
| `modules/upload/upload.routes.ts` | upload routes |
| `modules/upload/upload.controller.ts` | request parsing and response shaping |
| `modules/upload/upload.schemas.ts` | Zod validation |
| `modules/upload/upload.service.ts` | presign business logic |
| `shared/errors/error-codes.ts` | upload-related error codes |
| `docs/api/paths/upload.ts` | Swagger docs once implemented |
| `app/app.ts` | mount `/uploads` routes |

This is infrastructure plus a feature surface, so `infra/storage` and `modules/upload` is the clean split.

---

## 6. Endpoint Design

Use two endpoints:

- `POST /uploads/presigned-url`
- `POST /uploads/presigned-urls`

Both should be:

- authenticated
- workspace-scoped through `X-Workspace-Id`
- rate limited
- validated with Zod

Recommended middleware chain:

`authenticate -> validate -> requireWorkspace -> optional requireRole -> strictRateLimiter -> controller`

If you want stricter ordering for rate limiting in your app, keep it consistent with existing route conventions.

---

## 7. Single Upload Endpoint

### Route

`POST /uploads/presigned-url`

### Use Case

Use this for one image or one video at a time, for example:

- workspace logo
- team logo later
- one attachment picker item

### Request Contract

Recommended fields:

| Field | Required | Notes |
|---|---|---|
| `fileName` | Yes | Original client file name |
| `contentType` | Yes | Real MIME type from the browser |
| `size` | Yes | File size in bytes |
| `kind` | Yes | Example: `workspace-logo`, `avatar`, `attachment`, `video` |

The backend should not trust user-provided folder paths or S3 keys.

### Response Contract

Recommended response fields:

| Field | Purpose |
|---|---|
| `uploadUrl` | Signed S3 `PUT` URL |
| `method` | Usually `PUT` |
| `headers` | Required upload headers, especially `Content-Type` |
| `key` | Generated S3 object key |
| `expiresIn` | Expiry in seconds |
| `assetUrl` | Only if you intentionally expose public URLs |

---

## 8. Multiple Uploads Endpoint

### Route

`POST /uploads/presigned-urls`

### Use Case

Use this when the frontend selects multiple files in one action.

This endpoint means:

- multiple separate files
- one signed URL per file

This endpoint does **not** mean multipart upload for one huge video.

### Request Contract

Recommended request body:

| Field | Required | Notes |
|---|---|---|
| `files` | Yes | Array of file descriptors |

Each file descriptor should contain:

| Field | Required | Notes |
|---|---|---|
| `clientId` | Recommended | Lets frontend match response items |
| `fileName` | Yes | Original client file name |
| `contentType` | Yes | Browser MIME type |
| `size` | Yes | File size in bytes |
| `kind` | Yes | Same category model as single upload |

### Response Contract

Return one result per file in the same order as the request.

Each item should contain:

- `clientId` if provided
- `uploadUrl`
- `method`
- `headers`
- `key`
- `expiresIn`
- `assetUrl` only if applicable

Also enforce a hard max file count per request.

---

## 9. Validation Rules

The backend should validate these before signing anything:

### 9.1 Allowed MIME Types

Recommended image types:

- `image/jpeg`
- `image/png`
- `image/webp`
- `image/gif` only if you want animated images

Recommended video types:

- `video/mp4`
- `video/webm`
- `video/quicktime` if iPhone uploads matter

Avoid allowing:

- `image/svg+xml` unless you sanitize it
- generic wildcard types
- empty `contentType`

### 9.2 Size Limits

Set explicit limits by type:

- images: smaller limit
- videos: larger limit

Example policy direction:

- avatars and logos: small
- attachments: medium
- videos: larger but still bounded

Do not leave file size unbounded.

### 9.3 File Count Limits

For `presigned-urls`, cap the array length.

Good reasons:

- protects the presign endpoint
- reduces abuse risk
- keeps frontend and backend behavior predictable

### 9.4 Kind-Based Rules

Some file categories should have tighter rules.

Examples:

- `workspace-logo`: image only
- `avatar`: image only
- `attachment`: images and limited document types if you later add them
- `video`: video only

---

## 10. Object Key Strategy

Do not use the raw file name as the S3 key.

Generate keys on the backend.

Recommended shape:

- `workspaces/<workspaceId>/<kind>/<yyyy>/<mm>/<uuid>.<ext>`

Benefits:

- prevents collisions
- keeps tenant isolation obvious
- makes cleanup easier
- avoids trusting user input for storage paths

You can still store the original file name separately if the UI needs it.

---

## 11. Security Rules

### 11.1 Auth and Workspace Scope

Both endpoints should require:

- valid Clerk session
- valid workspace membership

This matches existing repo conventions for tenant-scoped routes.

### 11.2 Role Checks

Decide by upload kind whether every member can upload or only admins.

Suggested policy:

- workspace logo: `ADMIN`, `OWNER`
- avatar: authenticated user
- comment or issue attachments later: `MEMBER`, `ADMIN`, `OWNER`

### 11.3 Rate Limiting

Use stricter limits than normal read routes.

Uploads cost money and are a better abuse target than normal reads.

### 11.4 Private Bucket Default

If the bucket is private:

- do not return a permanent public URL
- return the `key`
- store the key in your DB
- create signed read access later if needed

### 11.5 Content-Type Consistency

The frontend must upload with the same `Content-Type` used when the URL was signed.

Mismatch here is a common failure source.

---

## 12. Frontend Flow

### 12.1 Single File Flow

1. User selects one file.
2. Frontend calls `POST /uploads/presigned-url`.
3. Backend returns the signed upload URL and object metadata.
4. Frontend uploads the file directly to S3.
5. After S3 returns success, frontend calls the real domain endpoint to save the file URL or key.

Example domain follow-up:

- upload workspace logo first
- then call workspace update with the final logo URL or object key

### 12.2 Multiple Files Flow

1. User selects multiple files.
2. Frontend calls `POST /uploads/presigned-urls`.
3. Backend returns one presigned URL per file.
4. Frontend uploads each file directly to S3.
5. Only after successful uploads should the frontend submit attachment metadata to the real feature endpoint.

The backend should not assume that every signed URL will actually be used.

---

## 13. Testing Checklist

Before considering the integration complete, verify all of the following:

### Bucket and IAM

- bucket region matches `AWS_REGION`
- IAM credentials can put objects into the bucket
- bucket CORS allows the frontend origin

### Backend

- app fails fast if S3 env vars are missing
- invalid MIME type returns `422`
- oversized file returns `422`
- unauthenticated request returns `401`
- non-member request returns `403`
- role-protected upload kinds are enforced

### Browser Upload

- image upload succeeds from the frontend
- video upload succeeds from the frontend
- uploaded object appears at the expected key
- follow-up domain update stores the returned key or URL correctly

---

## 14. Common Mistakes

### CORS Not Configured

The backend returns a signed URL, but the browser upload fails before it reaches S3 correctly.

### Wrong Region

The bucket exists, but presigned requests fail because `AWS_REGION` does not match the bucket.

### Treating `presigned-urls` as Multipart Upload

Batch signing several files is not the same as multipart upload for one large file.

If you later need very large videos, create a separate multipart upload flow.

### Trusting Client-Provided Paths

Do not let the client choose the bucket key or folder path.

### Saving DB Records Before Upload Succeeds

Only persist final file metadata after the browser finishes uploading to S3 successfully.

### Returning Public URLs from a Private Bucket

If the bucket is private, a plain object URL will not work for the client.

---

## 15. Recommended First Version for This Project

To keep scope controlled, the first implementation should do only this:

1. Support `POST /uploads/presigned-url` and `POST /uploads/presigned-urls`.
2. Accept only images and videos.
3. Use S3 presigned `PUT` URLs.
4. Keep the bucket private unless the product clearly needs public assets now.
5. Generate backend-controlled object keys with workspace prefixing.
6. Use authenticated, workspace-scoped routes.
7. Add strict validation and rate limiting.

That gives you a clean base for:

- workspace logo uploads now
- avatar uploads next
- comment and issue attachments later

---

## 16. File-by-File Implementation Checklist

When you start building this, use this sequence:

1. Add S3 env validation in `config/env.ts`.
2. Add upload-specific error codes in `shared/errors/error-codes.ts`.
3. Create `infra/storage` helpers for S3 client setup, key generation, and URL signing.
4. Create `modules/upload/upload.schemas.ts` for single and multiple presign request validation.
5. Create `modules/upload/upload.service.ts` for all presign logic.
6. Create `modules/upload/upload.controller.ts` to call the service and return standard responses.
7. Create `modules/upload/upload.routes.ts` with auth, workspace, validation, and rate limit middleware.
8. Mount the routes in `app/app.ts` at `/uploads`.
9. Add Swagger docs in `docs/api/paths/upload.ts` and register them in `docs/api/openapi.ts`.
10. Wire the frontend to request presigned URLs first and upload directly to S3.

---

## 17. Future Expansion

You will likely need separate flows later for:

- multipart uploads for large videos
- signed read URLs for private assets
- attachment metadata persistence
- cleanup of unused uploaded files
- image optimization or transcoding

Do not mix those concerns into the first version unless the current requirement actually needs them.
