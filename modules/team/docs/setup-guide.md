# Team Module — Setup Guide

> Phase 3 teams do not require external vendor setup.
> This guide covers the backend and frontend prerequisites for integration.

---

## 1. Prerequisites

These pieces must already be working:

- Clerk authentication
- active workspace selection
- `X-Workspace-Id` header injection in the frontend
- workspace membership and invitation acceptance

Required request headers for `/teams`:

- `Authorization: Bearer <clerk-session-token>`
- `X-Workspace-Id: <workspace-uuid>`

---

## 2. Backend Prerequisites

Team integration depends on:

- the Phase 3 team routes being mounted
- the Prisma client regenerated after the team schema update
- the latest migration applied

Use:

```bash
npx prisma generate
npx prisma migrate deploy
npm run build
```

---

## 3. Frontend Prerequisites

The frontend should be ready to handle:

- list responses with top-level `meta`
- compact and full query variants
- role-aware action visibility
- `404` on hidden private resources for guests
- `204 No Content` on delete/remove actions

---

## 4. Phase 3 Team Scope

Phase 3 team APIs cover:

- team CRUD
- team member list
- add/remove team members
- department linking
- lead assignment
- searchable list endpoints for directory and picker flows

Phase 3 does not cover:

- project CRUD
- issue CRUD
- team activity feed
- logo upload
