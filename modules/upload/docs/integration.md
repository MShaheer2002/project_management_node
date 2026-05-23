# Upload Module — Integration Guide

> This guide explains how the upload backend is implemented and how to test it with Postman before frontend integration.

---

## 1. Architecture

Upload requests follow the standard backend chain:

`Route -> authenticate -> requireWorkspace -> requireRole -> rate limiter -> validate -> controller -> service -> S3 signer`

Implementation is split into:

- `modules/upload/upload.routes.ts`
- `modules/upload/upload.controller.ts`
- `modules/upload/upload.service.ts`
- `modules/upload/upload.schemas.ts`
- `infra/storage/s3.ts`

The upload module does not persist DB records yet.

It only returns presigned upload instructions.

---

## 2. Route Contract

### Single File

`POST /uploads/presigned-url`

Request body:

```json
{
  "fileName": "logo.png",
  "contentType": "image/png",
  "size": 245678,
  "kind": "workspace-logo"
}
```

### Multiple Files

`POST /uploads/presigned-urls`

Request body:

```json
{
  "files": [
    {
      "clientId": "file-1",
      "fileName": "logo.png",
      "contentType": "image/png",
      "size": 245678,
      "kind": "attachment"
    },
    {
      "clientId": "file-2",
      "fileName": "demo.mp4",
      "contentType": "video/mp4",
      "size": 1024000,
      "kind": "video"
    }
  ]
}
```

Both routes require:

- `Authorization: Bearer <clerk-session-token>`
- `X-Workspace-Id: <workspace-uuid>`

---

## 3. Response Shape

All responses follow the backend standard shape:

```json
{
  "success": true,
  "data": {}
}
```

Single-file response data contains:

- `uploadUrl`
- `method`
- `headers`
- `key`
- `expiresIn`
- `assetUrl`

Batch response data contains:

- `uploads[]`

Each batch item contains:

- `clientId`
- `uploadUrl`
- `method`
- `headers`
- `key`
- `expiresIn`
- `assetUrl`

If `AWS_S3_PUBLIC_BASE_URL` is not configured:

- `assetUrl` is `null`
- use the returned `key` as the stable backend reference

---

## 4. Postman Test Flow

### Test 1: Request a Single Presigned URL

1. Create a `POST` request to `/uploads/presigned-url`.
2. Add bearer auth with a valid Clerk session token.
3. Add header `X-Workspace-Id`.
4. Send a JSON body for an allowed image or video.
5. Confirm the response returns:
   - `success: true`
   - `data.uploadUrl`
   - `data.key`
   - `data.headers.Content-Type`

### Test 2: Upload the File to S3

1. Create a new `PUT` request in Postman.
2. Paste the returned `uploadUrl` as the request URL.
3. Add the same `Content-Type` returned by the backend.
4. Use `Body -> binary` and select the local file.
5. Send the request.

Expected result:

- S3 returns success, usually HTTP `200`

Important:

- the file chosen in Postman must match the metadata you used when creating the presigned URL
- the `Content-Type` must match exactly

### Test 3: Request Multiple Presigned URLs

1. Create a `POST` request to `/uploads/presigned-urls`.
2. Send the batch JSON body with up to 10 files.
3. Confirm the response returns one upload instruction per file.
4. Repeat the direct S3 `PUT` upload for each returned URL.

---

## 5. Error Expectations

### Validation Errors

These return HTTP `422` with `VALIDATION_ERROR`:

- missing fields
- invalid body shape
- more than 10 files in `presigned-urls`

### Upload Policy Errors

These return HTTP `422` with module-specific error codes:

- `UPLOAD_TYPE_NOT_ALLOWED`
- `UPLOAD_FILE_TOO_LARGE`

### Auth and Permission Errors

These follow the shared backend rules:

- `401 UNAUTHORIZED`
- `403 NOT_WORKSPACE_MEMBER`
- `403 INSUFFICIENT_ROLE`

### Rate Limiting

Abusive or excessive requests return:

- `429 RATE_LIMITED`

---

## 6. Current Limits

- no multipart upload flow for very large videos
- no DB persistence for uploaded file records yet
- no signed read URL endpoint yet
- no cleanup job for unused uploaded objects yet

This is intentional for the first version.

---

## 7. Recommended Next Backend Step

After Postman validation succeeds, the next integration step should be:

1. upload the file through these endpoints
2. call the real feature endpoint with the returned `key` or public `assetUrl`

For example:

- request presigned URL for `workspace-logo`
- upload image to S3
- call workspace update endpoint with the final logo reference
