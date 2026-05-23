# Upload Module — Setup Guide

> This guide covers the backend prerequisites for S3 presigned uploads in this project.
> It is written for testing the API before frontend integration.

---

## 1. What This Module Adds

The upload module adds two authenticated workspace-scoped endpoints:

- `POST /uploads/presigned-url`
- `POST /uploads/presigned-urls`

These endpoints do not receive file binaries.

They only:

1. validate file metadata
2. generate an S3 object key
3. create a presigned S3 `PUT` URL
4. return upload instructions to the client

---

## 2. Required Environment Variables

These environment variables must exist before the server starts:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `AWS_S3_BUCKET`

Supported optional variables:

- `AWS_SESSION_TOKEN`
- `AWS_S3_URL_TTL_SECONDS`
- `AWS_S3_UPLOAD_PREFIX`
- `AWS_S3_PUBLIC_BASE_URL`
- `UPLOAD_IMAGE_MAX_BYTES`
- `UPLOAD_VIDEO_MAX_BYTES`

If `AWS_S3_PUBLIC_BASE_URL` is not set, the API still works and returns:

- `key`
- `uploadUrl`

In that case `assetUrl` returns `null`.

---

## 3. Bucket Requirements

The bucket must:

- exist in the region set by `AWS_REGION`
- allow `PutObject` for the configured IAM credentials
- allow browser `PUT` requests through bucket CORS if you later test from a frontend

For Postman testing, bucket CORS does not block the request the same way it does in a browser, but you should still configure it correctly now.

---

## 4. Allowed Upload Kinds

The backend currently supports these `kind` values:

- `workspace-logo`
- `avatar`
- `attachment`
- `video`

Current rules:

- `workspace-logo`: images only
- `avatar`: images only
- `attachment`: images and videos
- `video`: videos only

Guests cannot use these endpoints. The route requires workspace membership with role:

- `MEMBER`
- `ADMIN`
- `OWNER`

---

## 5. Allowed MIME Types

Images:

- `image/jpeg`
- `image/png`
- `image/webp`
- `image/gif`

Videos:

- `video/mp4`
- `video/webm`
- `video/quicktime`

Any other content type returns:

- HTTP `422`
- `UPLOAD_TYPE_NOT_ALLOWED`

---

## 6. Size Limits

The backend uses environment-configured size limits:

- `UPLOAD_IMAGE_MAX_BYTES`
- `UPLOAD_VIDEO_MAX_BYTES`

If a file exceeds the matching limit, the API returns:

- HTTP `422`
- `UPLOAD_FILE_TOO_LARGE`

---

## 7. Generated S3 Keys

The backend generates keys in this shape:

`<prefix>/workspaces/<workspaceId>/<kind>/<year>/<month>/<uuid>.<ext>`

Example:

`uploads/workspaces/2f7.../workspace-logo/2026/05/5b3....png`

The client cannot choose the final key.

---

## 8. Postman Prerequisites

Before testing:

1. start the backend
2. use a valid Clerk bearer token
3. use a real workspace ID in `X-Workspace-Id`
4. prepare a local image or video file for the second request

You will make two requests for each test:

1. request a presigned URL from the backend
2. upload the file directly to S3 using the returned `uploadUrl`

---

## 9. Server Validation Expectations

The API will reject:

- missing auth
- missing `X-Workspace-Id`
- invalid request body
- unsupported MIME type
- files that exceed configured size limits
- guests trying to upload

This is the intended first version for pre-frontend testing.
