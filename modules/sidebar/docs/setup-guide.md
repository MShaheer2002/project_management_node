# Sidebar Module — Setup Guide

The sidebar module has no external setup. It returns authenticated app shell data for the active workspace.

## Prerequisites

- Clerk authentication is configured.
- The user has selected an active workspace.
- Requests include `X-Workspace-Id`.

## Endpoint

| Method | Path | Auth | Workspace | Description |
|---|---|---|---|---|
| `GET` | `/sidebar` | Required | `X-Workspace-Id` header | Returns sidebar/app shell aggregate |

## Frontend Flow

After login/signup:

1. Call `GET /workspaces`.
2. If empty, show onboarding.
3. If non-empty, select/store the active workspace ID.
4. Call `GET /sidebar` with `X-Workspace-Id`.
5. Call `GET /dashboard` with the same workspace ID.
