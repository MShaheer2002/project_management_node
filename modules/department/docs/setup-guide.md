# Department Module — Setup Guide

> Phase 3 departments do not require any third-party dashboard setup.
> This guide covers the backend prerequisites the frontend depends on.

---

## 1. Prerequisites

Before integrating departments, these phases must already be working:

- Phase 1 auth
- Phase 2 workspace selection and membership
- active workspace header handling on the frontend

The frontend must already send:

- `Authorization: Bearer <clerk-session-token>`
- `X-Workspace-Id: <workspace-uuid>` for `/departments` routes

---

## 2. Backend Prerequisites

The backend must be on a build that includes:

- department routes mounted at `/departments`
- the latest Prisma schema
- the Phase 3 migration for team metadata already applied

Required local commands:

```bash
npx prisma generate
npx prisma migrate deploy
npm run build
```

---

## 3. Frontend Prerequisites

The frontend should have these basics in place before wiring department screens:

- a shared API client that injects `X-Workspace-Id`
- standard handling for `{ success, data }` and `{ success, data, meta }`
- field-level rendering for `422 VALIDATION_ERROR`
- role-aware UI gating for `OWNER`, `ADMIN`, `MEMBER`, `GUEST`

---

## 4. What Phase 3 Departments Include

Phase 3 department support covers:

- department CRUD
- department member list
- add/remove department members
- guest/private visibility rules
- compact picker responses and full page responses

Phase 3 does not include:

- activity feed
- analytics beyond simple counts
- department icon management API
- file upload
