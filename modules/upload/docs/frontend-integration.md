# Upload Module — Frontend Integration Guide

> This guide explains how the frontend should integrate with the presigned upload endpoints.
> It covers both single-file and multi-file flows and the current backend limitations you must account for in UI logic.

---

## 1. Core Concept

The frontend never sends the actual image or video file to the backend upload endpoint.

Instead, the flow is always:

1. send file metadata to the backend
2. receive a presigned S3 `PUT` URL
3. upload the file directly from the browser to S3
4. use the returned `key` or `assetUrl` in the real feature flow

This keeps large files out of the Node server and matches the backend implementation.

---

## 2. Available Endpoints

The frontend can use:

- `POST /uploads/presigned-url`
- `POST /uploads/presigned-urls`

Use `presigned-url` when the user uploads one file.

Use `presigned-urls` when the user selects multiple files in one action.

`presigned-urls` is for multiple separate files.

It is not a multipart upload API for one very large video.

---

## 3. Auth and Workspace Context

Both endpoints require:

- `Authorization: Bearer <clerk-session-token>`
- `X-Workspace-Id: <workspace-uuid>`

The direct S3 upload request must **not** include:

- bearer auth
- `X-Workspace-Id`
- backend cookies

The S3 upload uses the presigned URL as its auth mechanism.

---

## 4. Supported Upload Kinds

Current supported `kind` values:

- `workspace-logo`
- `avatar`
- `attachment`
- `video`

Current backend rules:

- `workspace-logo`: image only
- `avatar`: image only
- `attachment`: image or video
- `video`: video only

Do not let the frontend send arbitrary categories.

---

## 5. Single File Flow

### Step 1: Read File Metadata in the Browser

From the selected `File`, the frontend needs:

- `file.name`
- `file.type`
- `file.size`

Map those into the backend request body.

### Step 2: Request a Presigned URL

Call:

`POST /uploads/presigned-url`

Request body shape:

```json
{
  "fileName": "logo.png",
  "contentType": "image/png",
  "size": 245678,
  "kind": "workspace-logo"
}
```

### Step 3: Use the Response

The response data contains:

- `uploadUrl`
- `method`
- `headers`
- `key`
- `expiresIn`
- `assetUrl`

The frontend must use:

- `uploadUrl` as the destination for the direct browser upload
- `headers` exactly as returned
- `key` as the stable backend-side reference

### Step 4: Upload to S3

Send a direct `PUT` request from the browser to `uploadUrl`.

Rules:

- use the actual file as the request body
- send the exact `Content-Type` returned by the backend
- do not attach auth headers
- do not send JSON

### Step 5: Complete the Real Feature Flow

After S3 upload succeeds, call the real feature endpoint.

Examples:

- workspace logo upload -> update the workspace logo field
- avatar upload -> update the user avatar field
- attachment upload -> create the attachment record in the real feature module

The frontend should only do this after the S3 upload succeeds.

---

## 6. Multiple File Flow

### Step 1: Build the Batch Request

Call:

`POST /uploads/presigned-urls`

Request body shape:

```json
{
  "files": [
    {
      "clientId": "image-1",
      "fileName": "cover.png",
      "contentType": "image/png",
      "size": 245678,
      "kind": "attachment"
    },
    {
      "clientId": "video-1",
      "fileName": "demo.mp4",
      "contentType": "video/mp4",
      "size": 1024000,
      "kind": "video"
    }
  ]
}
```

`clientId` is not required by the backend, but the frontend should send it.

It lets you map each returned presigned upload instruction back to the original selected file.

### Step 2: Match Response Items Back to Files

Each returned item contains:

- `clientId`
- `uploadUrl`
- `headers`
- `key`
- `assetUrl`

Use `clientId` to match the response item to the local file object in memory.

### Step 3: Upload Each File Directly to S3

For each file:

1. find its matching response item
2. send the direct `PUT` request to `uploadUrl`
3. send the exact returned headers
4. use the corresponding local file as the request body

Only after the uploads succeed should the frontend submit the batch metadata to the next real backend endpoint.

---

## 7. UI State Recommendations

The upload flow should have separate states:

- `idle`
- `preparing`
- `uploading`
- `uploaded`
- `failed`

Recommended behavior:

- disable the submit button while requesting the presigned URL
- show progress while uploading to S3
- if S3 upload fails, do not call the follow-up business endpoint
- if the follow-up business endpoint fails after upload succeeds, keep the uploaded file reference available for retry logic

For multi-file flows, track status per file instead of one global boolean.

---

## 8. Error Handling

### Backend Presign Errors

The presign endpoint can return:

- `401 UNAUTHORIZED`
- `403 NOT_WORKSPACE_MEMBER`
- `403 INSUFFICIENT_ROLE`
- `422 VALIDATION_ERROR`
- `422 UPLOAD_TYPE_NOT_ALLOWED`
- `422 UPLOAD_FILE_TOO_LARGE`
- `429 RATE_LIMITED`

Frontend handling guidance:

- `VALIDATION_ERROR`: treat as a client-side bug or a stale UI contract
- `UPLOAD_TYPE_NOT_ALLOWED`: show a file type message
- `UPLOAD_FILE_TOO_LARGE`: show a file size message
- `UNAUTHORIZED`: redirect to auth refresh or sign-in
- `NOT_WORKSPACE_MEMBER` or `INSUFFICIENT_ROLE`: block the flow and show permission messaging

### S3 Upload Errors

The direct S3 upload can fail because of:

- wrong `Content-Type`
- expired presigned URL
- browser/network interruption
- S3 bucket CORS misconfiguration

Frontend handling guidance:

- retry by requesting a fresh presigned URL
- do not reuse an expired `uploadUrl`
- if the browser reports a CORS failure, treat it as an infrastructure issue rather than a user validation issue

---

## 9. `assetUrl` vs `key`

This is the most important frontend integration detail in the current implementation.

### When `assetUrl` Is Present

If the backend is configured with `AWS_S3_PUBLIC_BASE_URL`, the response may include:

- `assetUrl`

In that case:

- `assetUrl` is the frontend-friendly permanent file URL
- `key` is still useful for backend-side tracking or cleanup

### When `assetUrl` Is `null`

If the backend is not configured with `AWS_S3_PUBLIC_BASE_URL`, the response returns:

- `assetUrl: null`
- a valid `key`

In that case:

- the upload still succeeded
- the frontend must treat `key` as the stored reference
- the raw S3 object URL is not assumed to be public

This matters for your current workspace logo flow because the existing workspace update schema expects a URL, not an S3 key.

So for `workspace-logo`, the frontend can only complete the full logo-save flow if either:

- `assetUrl` is returned, or
- the backend is later changed to store a key instead of a URL

---

## 10. Recommended Frontend Contract

For each uploaded file, keep a local object like:

- original browser file
- upload request metadata
- presigned response data
- upload status
- final reference to persist

Suggested persistence rule:

- if `assetUrl` exists, use it where a public URL is required
- always retain `key` for backend-side reference

This avoids losing track of uploaded objects when later flows expand.

---

## 11. Example End-to-End Flows

### Workspace Logo

1. user selects an image
2. frontend calls `POST /uploads/presigned-url` with `kind: "workspace-logo"`
3. frontend uploads the image directly to S3
4. if `assetUrl` exists, frontend calls workspace update with that URL as `logo`
5. if `assetUrl` is `null`, the current workspace update flow cannot finish without backend changes or public asset configuration

### Comment or Issue Attachment

1. user selects one or more files
2. frontend calls `POST /uploads/presigned-urls`
3. frontend uploads all files directly to S3
4. frontend sends the uploaded `key` or `assetUrl` list to the real attachment endpoint

### Avatar

1. user selects an image
2. frontend calls `POST /uploads/presigned-url` with `kind: "avatar"`
3. frontend uploads the image directly to S3
4. frontend persists the returned reference through the user profile update flow

---

## 12. Current Limitations

The frontend should account for these current backend limits:

- no multipart upload API for very large videos
- no signed read URL endpoint for private files
- no automatic file cleanup for abandoned uploads
- no upload-complete callback from S3 to the backend

Do not design the UI assuming those features already exist.

---

## 13. What the Frontend Should Not Do

Do not:

- send the binary file to `/uploads/presigned-url`
- send `form-data` to the presign endpoints
- send auth headers to the S3 `PUT` request
- store the temporary `uploadUrl` as if it were the final file URL
- assume the object is public when `assetUrl` is `null`

Those are the most common integration mistakes.
