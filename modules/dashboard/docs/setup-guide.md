# Dashboard Module — Setup Guide

The dashboard module has no external provider setup. It reads existing workspace data and returns a single aggregate payload for the first screen after signup/login.

## Prerequisites

- Clerk auth is configured.
- Workspace context is available through `X-Workspace-Id`.
- Prisma models from the initial schema are migrated.

## Endpoint

| Method | Path | Auth | Workspace | Description |
|---|---|---|---|---|
| `GET` | `/dashboard` | Required | `X-Workspace-Id` header | Returns dashboard aggregate data |

## Frontend Usage

After login or signup:

1. Call `GET /workspaces`.
2. Select or create the active workspace.
3. Call `GET /dashboard` with `X-Workspace-Id: <workspaceId>`.

Fresh workspaces return zero counts and empty lists, so the UI can render empty states without extra branching.
