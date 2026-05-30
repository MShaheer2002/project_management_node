# Phase 12 Frontend Template Integration Guide

This document defines frontend integration for templates (Phase 12), including template CRUD, activation flow, draft-apply flow, issue creation linkage, activity, notifications, and realtime sync.

Backend references:
- [phase-12-backend-setup-guide.md](./phase-12-backend-setup-guide.md)
- [phase12-backend-contract.md](./phase12-backend-contract.md)
- [phase-11-frontend-cycle-integration-guide.md](./phase-11-frontend-cycle-integration-guide.md)

## Preconditions

- Workspace auth and role guards are active.
- Phase 10 socket client integration is active.
- Phase 9 notification inbox and unread badge are active.
- `X-Workspace-Id` is sent for all template calls.

## Routes

```txt
GET    /templates/defaults
GET    /templates/active
GET    /templates
GET    /templates/:id
POST   /templates
PATCH  /templates/:id
DELETE /templates/:id
POST   /templates/:id/duplicate
POST   /templates/:id/apply
POST   /templates/:id/activate
POST   /templates/:id/activate/confirm
POST   /templates/:id/default/confirm
POST   /templates/:id/deactivate
```

Issue integration route:

```txt
POST /issues
```

`POST /issues` can include:

- `templateId?: string`
- `templateDraftId?: string` (optional passthrough)

## Role Expectations

- read (`defaults`, `active`, list, detail): guest/member/admin/owner
- apply: member/admin/owner
- manage (create/update/delete/duplicate/activate/deactivate/default-confirm): admin/owner

Frontend must hide/disable management actions for non-admin/owner roles.

## Defaults Source of Truth

Always fetch:

- `GET /templates/defaults`

Use this response to seed new-template editor options:

- `categoryOptions`
- `priorityOptions`
- `statusOptions`
- `labelOptions`

Do not hardcode these lists in frontend.

`GET /templates/active` accepts:

- `issueType`
- `teamId`
- `projectId`

Use `teamId` and/or `projectId` when available so the backend can resolve the best visible templates for that page context.

## Scope Model

Each template includes:

- `scopeType: 'WORKSPACE' | 'TEAM' | 'PROJECT'`
- `scopeId: string | null`
- `isDefault: boolean`

UI rules:

- `WORKSPACE` is the global workspace template
- `TEAM` is assigned to one team
- `PROJECT` is assigned to one project
- only `WORKSPACE` templates can be marked default
- `TEAM` and `PROJECT` selections should open a scoped picker for the target entity

## Template Data Shape

Treat template as backend-owned record with:

- option banks (`categoryOptions`, `priorityOptions`, `statusOptions`, `labelOptions`)
- selected defaults (`defaultPriority`, `defaultStatus`, `defaultLabelIds`, etc.)
- ownership/scope (`scopeType`, `scopeId`, `isDefault`)
- lifecycle (`lifecycle`, `isActive`)
- usage metadata (`usageCount`, `timesApplied`, `lastAppliedAt`)
- current-user application state (`appliedByCurrentUser`, `appliedAt`, `appliedDraft`)

## Template List/Filters

`GET /templates` query supports:

- `q`
- `category`
- `issueType` (`task | bug | issue`)
- `scopeType` (`WORKSPACE | TEAM | PROJECT`)
- `scopeId`
- `creatorId`
- `sort` (`updatedAt:desc`, `updatedAt:asc`, `createdAt:desc`, `createdAt:asc`, `name:asc`)
- `lifecycle` (`ACTIVE | INACTIVE | ARCHIVED`)
- `isActive`
- `cursor`
- `limit`

Use cursor pagination only.

## Activation Conflict UX

Flow for `POST /templates/:id/activate`:

1. If success, mark active template in UI.
2. If `409 TEMPLATE_ALREADY_ACTIVE`, show confirmation modal using backend message.
3. On confirm, call `POST /templates/:id/activate/confirm`.
4. Refresh template list/detail and active catalog.

Never auto-call confirm without user consent.

## Default Conflict UX

When saving a workspace template with `isDefault=true`:

1. If no workspace default exists for the issue type, save normally.
2. If one already exists, show a confirmation dialog using backend conflict details.
3. On confirm, call `POST /templates/:id/default/confirm`.
4. Refresh template list and active catalog.

Expected backend code:

- `TEMPLATE_DEFAULT_CONFLICT`

## Apply-to-Draft Flow

`POST /templates/:id/apply` returns a wrapper payload with the generated draft and the persisted apply-state metadata.

Draft shape:

```ts
type TemplateApplyDraft = {
  templateId: string;
  title: string;
  description: string;
  issueType: 'task' | 'bug' | 'issue';
  scopeType: 'WORKSPACE' | 'TEAM' | 'PROJECT';
  scopeId: string | null;
  isDefault: boolean;
  priority: string;
  status: string;
  customStatus: string | null;
  assigneeType: 'UNASSIGNED' | 'CREATOR' | 'SPECIFIC_USER';
  assigneeId: string | null;
  estimate: number | null;
  dueDateOffset: number | null;
  labels: string[]; // currently label IDs from backend defaults
  subtasks: string[];
  severity: 'low' | 'medium' | 'high' | null;
  stepsToReproduce: string | null;
  expectedBehavior: string | null;
  actualBehavior: string | null;
  acceptanceCriteria: string | null;
  relatedIssueKeys: string | null;
  notes: string | null;
};
```

Frontend behavior:

1. User selects template.
2. Call apply endpoint.
3. Pre-fill issue create form from `data.draft`.
4. User edits fields.
5. Submit `POST /issues` explicitly.
6. Keep the selected template in page state if the user navigates away and back before creation completes.
7. Persist the applied template in client state keyed by `workspaceId + templateId + userId` and restore it on remount from backend detail/list state.
8. If the backend returns `appliedByCurrentUser: true`, render the template as already applied and do not show the apply CTA again on revisit.

Applying a template does not create issue.
If the backend reports `appliedByCurrentUser: true` for the template, the frontend must treat the template as already applied and hide the apply CTA when the user returns to the template page.

Expected apply response shape:

```ts
type TemplateApplyResponse = {
  draft: TemplateApplyDraft;
  appliedByCurrentUser: true;
  appliedAt: string;
  templateId: string;
  scopeType: 'WORKSPACE' | 'TEAM' | 'PROJECT';
  scopeId: string | null;
  appliedDraft: TemplateApplyDraft;
};
```

## Issue Create Integration

When creating issue from template:

1. Keep editable fields in form (title, description, status, priority, assignee, labels, estimate, due date, type-specific fields).
2. Submit `templateId` with `POST /issues` to preserve backend linkage.
3. If user overrides values, send overridden values.

Backend stores template linkage metadata (`templateId`, `templateVersion`, `templateAppliedAt`) on created issue.

Current backend behavior notes:

- If `templateId` is sent, backend applies template defaults server-side for missing fields.
- If `labels` are not provided in issue payload, backend attempts to attach template `defaultLabelIds`.
- `templateDraftId` is accepted by validation but not persisted or required by backend logic yet.
- Call `GET /templates/active` with `teamId` and/or `projectId` when those IDs are known so the backend can resolve visible templates by scope precedence.
- `GET /templates/:id` now returns `appliedByCurrentUser`, `appliedAt`, and `appliedDraft` for the current user only.
- `GET /templates` and `GET /templates/active` return `appliedByCurrentUser` and `appliedAt` so list views can suppress the apply button for already-applied templates.
- The backend persists the user's last applied draft in `TemplateApplication`; this does not mutate the template record itself.
- When reopening a template detail page, hydrate the form from `appliedDraft` if present instead of resetting to blank template defaults.
- `POST /templates/:id/apply` should be handled as a stateful response, not a stateless draft-only response.

## Realtime Events

Workspace socket events for templates:

- `template.created`
- `template.updated`
- `template.deleted`
- `template.activated`
- `template.deactivated`

Client behavior:

- invalidate template list/detail/active-catalog queries on these events
- dedupe by realtime envelope `id`
- when a template detail/list response says `appliedByCurrentUser: true`, keep the template marked as applied until the user explicitly clears or replaces it
- if `appliedByCurrentUser` is true and `appliedDraft` exists, reuse it when restoring the page state after navigation
- if current detail is deleted, redirect to list

Socket payload minimum:

- `workspaceId`
- `templateId`
- `issueType`
- `isActive`
- `updatedAt`

## Notifications

Template lifecycle operations can produce inbox notifications.

Frontend should:

- keep listening to `notification:created`
- update unread badge via socket payload
- refetch `/notifications` and `/notifications/unread-count` on reconnect/tab-focus

## Activity Integration

Template operations are visible in activity feed via backend activity model:

- `TEMPLATE_CREATED`
- `TEMPLATE_UPDATED`
- `TEMPLATE_DELETED`
- `TEMPLATE_ACTIVATED`
- `TEMPLATE_DEACTIVATED`
- `TEMPLATE_APPLIED`

For rendering, rely on `message` and `metadata` from activity payload.

Target mapping:

- activity target type for templates is `template`
- activity metadata includes `templateId`, `templateName`, `issueType` (and `confirmedSwap` where applicable)

## Suggested Query Keys

- `['template-defaults', workspaceId]`
- `['templates', workspaceId, params]`
- `['template', workspaceId, templateId]`
- `['template-active', workspaceId, params]`
- `['issues', workspaceId, params]`
- `['issue', workspaceId, issueId]`
- `['activity', workspaceId, params]`
- `['notifications', workspaceId, params]`
- `['notifications-unread', workspaceId]`

Reset cursor when filter/sort changes.

## Error Handling

Handle expected errors:

- `TEMPLATE_NOT_FOUND`
- `TEMPLATE_ALREADY_ACTIVE`
- `TEMPLATE_ACTIVATION_CONFLICT`
- `TEMPLATE_VALIDATION_FAILED`
- `VALIDATION_ERROR`
- `FORBIDDEN`
- `ASSIGNEE_NOT_WORKSPACE_MEMBER`
- `LABEL_NOT_FOUND`
- `TEMPLATE_DEFAULT_CONFLICT`
- `TEMPLATE_NAME_TAKEN`

Status mapping:

- `422` input/contract validation
- `409` activation conflict
- `403` role/permission rejection
- `404` missing template/resource

Current backend-specific validation messages to surface:

- `ISSUE type template requires acceptanceCriteriaTemplate`
- `defaultPriority must be inside priorityOptions`
- `defaultStatus must be inside statusOptions`
- `One or more default labels not found`
- `scopeId must be null for WORKSPACE scope`
- `scopeId is required for TEAM and PROJECT scopes`
- `Only WORKSPACE templates can be defaults`

## Completion Checklist

- [ ] Template defaults consumed from backend endpoint
- [ ] Template list/detail/create/update/delete integrated
- [ ] Scope selector and entity picker integrated
- [ ] Workspace default checkbox only appears for workspace scope
- [ ] Activate + confirm-swap flow integrated
- [ ] Default replacement confirm flow integrated
- [ ] Apply-to-draft flow integrated before issue creation
- [ ] Applied template persists across navigation and reopens in applied state
- [ ] `POST /issues` sends `templateId` when template-based
- [ ] Realtime template events keep list/detail/active state fresh
- [ ] Notification inbox and unread badge remain in sync
- [ ] Template activity events visible in activity surfaces
- [ ] Apply draft fields map exactly to issue-create form fields
- [ ] Activation conflict modal calls `/templates/:id/activate/confirm` only on explicit user approval
