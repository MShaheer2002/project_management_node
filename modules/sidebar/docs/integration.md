# Sidebar Module — Integration Guide

## Architecture

The sidebar module is a read-only aggregate for the authenticated app shell:

```text
Route -> authenticate -> requireWorkspace -> Controller -> Service -> Prisma
```

The workspace switcher needs all workspaces for the current user, while teams and badge counts are scoped to the active workspace.

## Returned Data

`GET /sidebar` returns:

- `user`: current user profile plus role in the active workspace.
- `workspaces`: workspace switcher entries for every workspace the user belongs to.
- `activeWorkspace`: display data and role for the active workspace.
- `badges`: unread inbox count, assigned issue count, and pending invitation count for admins/owners.
- `teams`: teams the current user belongs to in the active workspace.
- `permissions`: booleans for role-based UI visibility.

## Notes

The endpoint requires `X-Workspace-Id` because sidebar teams, counts, and permissions depend on active workspace context. Use `GET /workspaces` before this endpoint when the app does not yet know which workspace is active.
