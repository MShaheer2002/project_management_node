# Phase 12 Backend Setup Guide (Issue Templates)

> Phase 12 adds workspace-scoped issue templates as reusable blueprints.
> Follow immutable rules in [rules.md](./rules.md): Route -> Middleware -> Controller -> Service -> DB.

Backend references:
- [phase12-backend-contract.md](./phase12-backend-contract.md)
- [build-phases.md](./build-phases.md)
- [rules.md](./rules.md)

---

## 1. Prerequisites

Required completed phases:

- Phase 3 (workspace/team/department/roles)
- Phase 4 (projects)
- Phase 5 (issues)
- Phase 8 (activity)
- Phase 9 (notifications)
- Phase 10 (socket realtime)
- Phase 11 (cycles)

Required middleware chain for protected template routes:

- `authenticate`
- `requireWorkspace`
- `requireRole`

---

## 2. Module Structure

Create module:

```txt
modules/template/
├── template.routes.ts
├── template.controller.ts
├── template.service.ts
└── template.schemas.ts
```

Rules:

- controllers do not contain business logic
- controllers do not use Prisma
- services do all validation-dependent business decisions
- every workspace-scoped query must include `workspaceId`

---

## 3. Prisma Data Model

Add `Template` model and enums (or equivalent string fields if your schema pattern is string-based).

Required fields:

- identity/scope: `id`, `workspaceId`
- main: `name`, `description`, `issueType`, `scopeType`, `scopeId`, `isDefault`, `category`, `customCategory`
- content: `titleTemplate`, `contentTemplate`
- defaults: `defaultPriority`, `defaultStatus`, `customStatus`, `defaultAssigneeType`, `defaultAssigneeId`, `defaultEstimate`, `defaultDueDateOffset`, `defaultSeverity`, `defaultLabelIds`
- option banks: `categoryOptions`, `priorityOptions`, `statusOptions`, `labelOptions`
- structured metadata: `checklistItems`, `stepsToReproduceTemplate`, `expectedBehaviorTemplate`, `actualBehaviorTemplate`, `acceptanceCriteriaTemplate`, `relatedIssueKeysTemplate`, `notesTemplate`
- lifecycle: `lifecycle`, `isActive`, `activeVersion`, `deletedAt`
- usage: `usageCount`, `timesApplied`, `lastAppliedAt`
- audit: `createdById`, `updatedById`, `createdAt`, `updatedAt`

Required indexes/constraints:

- index `(workspaceId, issueType)`
- index `(workspaceId, scopeType, scopeId)`
- index `(workspaceId, isActive)`
- index `(workspaceId, lifecycle)`
- unique active template guard per issue type:
  - recommended DB enforcement with partial unique index:
- one active template per `(workspaceId, issueType)` where `isActive = true` and `deletedAt is null`
- one workspace default per `(workspaceId, issueType)` where `scopeType = WORKSPACE` and `isDefault = true`

Run:

```bash
npx prisma generate
npx prisma migrate dev --name phase12_templates
npx prisma migrate deploy
npm run build
```

---

## 4. Backend-Owned Defaults

Implement defaults catalog in service constants (not frontend):

- category: `Bug`, `Feature`, `Task`, `QA`, `Research`, `Security`, `Release`, `Onboarding`
- priority: `low`, `medium`, `high`, `urgent`
- status: `backlog`, `todo`, `in-progress`, `review`, `done`
- labels: `bug`, `feature`, `task`, `qa`, `research`, `security`, `release`, `onboarding`, `review`, `product`

Expose:

- `GET /templates/defaults`

Rules:

- frontend must consume this endpoint as source of truth
- create/update fallback uses these defaults when request omits option banks/selected defaults
- active catalog should resolve scope precedence in this order: project > team > workspace

---

## 5. API Endpoints

Implement:

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

Role policy:

- list/view/detail/defaults/active: `GUEST`, `MEMBER`, `ADMIN`, `OWNER`
- create/update/delete/duplicate/activate/deactivate/default-confirm: `ADMIN`, `OWNER`
- apply: `MEMBER`, `ADMIN`, `OWNER` (optional for `GUEST` per workspace policy)

---

## 6. Zod Validation

`template.schemas.ts` must validate:

- route params IDs
- query filters: `q`, `category`, `issueType`, `creatorId`, `sort`, `lifecycle`, `isActive`, `cursor`, `limit`
- create/update scope constraints:
  - `scopeType` required on create
  - `scopeId` required for team/project scopes
  - `scopeId` must be null for workspace scope
  - `isDefault` only allowed for workspace scope
- create/update payload constraints:
  - `name`, `description`, `contentTemplate` non-empty
  - valid `issueType`
  - `defaultPriority` in `priorityOptions`
  - `defaultStatus` in `statusOptions`
  - `defaultLabelIds` consistent with `labelOptions` and workspace labels mapping
  - `defaultAssigneeType` enum and assignee requirements
  - bug templates enforce bug metadata when required by issue model
  - issue templates enforce `acceptanceCriteriaTemplate` if issue workflow requires it

Reject invalid payloads with `422 VALIDATION_ERROR`.

---

## 7. Service Behavior

### `createTemplate`

- merge request with backend defaults when fields omitted
- verify workspace scope and actor role
- validate scope assignment before save
- validate selected defaults are contained in option banks
- set initial `isActive=false` unless explicitly activated later
- persist within workspace
- emit activity/notification/socket event

### `listTemplates` / `getTemplateById`

- strictly workspace-scoped
- exclude soft-deleted by default
- support filters and cursor pagination
- include usage and activation metadata

### `updateTemplate`

- update only template record
- do not mutate existing issues created from this template
- bump `activeVersion` when material fields change
- emit activity/notification/socket

### `deleteTemplate`

- soft delete (`deletedAt`)
- deactivate if active
- preserve history
- emit activity/notification/socket

### `duplicateTemplate`

- clone content/options/defaults
- new `id`, `usageCount=0`, `timesApplied=0`, `lastAppliedAt=null`
- default `isActive=false`
- preserve `scopeType`/`scopeId`, but never duplicate `isDefault`
- emit activity/socket

### `applyTemplate`

- must return draft only (no issue creation)
- map template to issue-draft fields consistently
- include scope metadata in the draft response
- increment `timesApplied`, `usageCount`, set `lastAppliedAt`
- persist the user's last applied draft in `TemplateApplication` without mutating the template row
- emit template-applied activity

### `activateTemplate`

- if none active for `(workspaceId, issueType)`: activate directly
- if active exists: return `409 TEMPLATE_ALREADY_ACTIVE` with conflict payload (`requiresConfirmation=true`)

### `confirmActivationSwap`

- transactionally:
  - deactivate current active template
  - activate candidate template
- emit activity/notification/socket

### `confirmDefaultSwap`

- transactionally:
  - demote the previous workspace default
  - promote the candidate template as the new default
- only workspace-scoped templates can be promoted
- emit activity/socket for both templates

### `deactivateTemplate`

- set `isActive=false`
- set `isDefault=false` when demoting a workspace default manually
- keep record reusable
- emit activity/socket

---

## 8. Activation Concurrency and Safety

Use `prisma.$transaction` for activation operations.

Protection layers:

- service-level conflict checks
- DB-level unique active constraint (recommended)
- idempotent confirm endpoint behavior

If two activation requests race, one must fail cleanly with `409`.

---

## 9. Issue Creation Integration

`POST /issues` integration rules:

- if `templateId` supplied:
  - resolve template in same workspace
  - generate draft-equivalent mapped values
  - preserve linkage in issue metadata (`templateId`, `templateVersion`, `appliedAt`)
- if a user already has an applied template snapshot, the frontend can restore it from `GET /templates/:id` or the template list response via `appliedByCurrentUser` and `appliedDraft`
- if no template:
  - apply backend default issue type/priority/status/labels

Important:

- template apply endpoint never creates issue
- issue create remains explicit user action

---

## 10. Activity Integration

Add activity types (or mapped equivalents):

- `TEMPLATE_CREATED`
- `TEMPLATE_UPDATED`
- `TEMPLATE_DELETED`
- `TEMPLATE_ACTIVATED`
- `TEMPLATE_DEACTIVATED`
- `TEMPLATE_APPLIED`

Metadata should include:

- `templateId`
- `templateName`
- `issueType`
- `activeVersion`
- actor context

If template leads to issue creation, log both:

- template-applied event
- issue-created event with template linkage metadata

---

## 11. Notification Integration

Trigger workspace-scoped notifications where relevant:

- template activated by another admin/owner
- template updated when active
- template deleted while referenced in active workflows
- mentions in template discussion surfaces (if implemented)

Rules:

- never notify cross-workspace recipients
- skip actor self-notification by default
- obey notification preference/filter logic from Phase 9

---

## 12. Socket Integration

Broadcast to `workspace:<workspaceId>`:

- `template.created`
- `template.updated`
- `template.deleted`
- `template.activated`
- `template.deactivated`

Payload minimum:

- `workspaceId`
- `templateId`
- `issueType`
- `isActive`
- `updatedAt`

Use standard realtime envelope from Phase 10.

---

## 13. Performance and Query Optimization

Required:

- use indexed filters for list/active queries
- cursor pagination for template list
- select only needed columns in list view
- avoid N+1 lookups (join creator metadata in one query or minimal include)

Recommended:

- cache `/templates/defaults` per workspace with safe invalidation
- keep `applyTemplate` computation pure and lightweight

---

## 14. DB Verification Checklist

After migration, verify:

1. `Template` table exists with all required columns.
2. Indexes exist (`workspaceId+issueType`, `workspaceId+scopeType+scopeId`, `workspaceId+isActive`, `workspaceId+lifecycle`).
3. Unique-active constraint works:
   - activating second template of same issueType fails with `409`/DB conflict handling.
4. Workspace default constraint works:
   - saving a second workspace default for same issueType returns `TEMPLATE_DEFAULT_CONFLICT`.
5. Soft delete behavior:
   - deleted templates excluded from normal list but retained in DB.
6. `applyTemplate` updates `timesApplied`, `usageCount`, `lastAppliedAt`.
7. `TemplateApplication` rows persist the current user's applied draft snapshot.
8. Activity rows insert for all template lifecycle operations.
9. Notifications are only generated for valid same-workspace recipients.
10. Socket events fire for create/update/delete/activate/deactivate.

---

## 15. Error Codes

Use explicit backend codes:

- `TEMPLATE_NOT_FOUND`
- `TEMPLATE_ALREADY_ACTIVE`
- `TEMPLATE_ACTIVATION_CONFLICT`
- `TEMPLATE_DEFAULT_CONFLICT`
- `TEMPLATE_NAME_TAKEN`
- `TEMPLATE_VALIDATION_FAILED`
- `FORBIDDEN`
- `VALIDATION_ERROR`

Standard response shape must remain:

- success: `{ "success": true, "data": ... }`
- error: `{ "success": false, "error": { "code", "message", ... } }`

---

## 16. Implementation Order (Recommended)

1. Add Prisma model/enums/indexes + migration.
2. Add `template` module schemas/routes/controller/service.
3. Implement defaults endpoint and seed logic.
4. Implement CRUD + duplicate + soft delete.
5. Implement apply-draft endpoint.
6. Implement activation conflict + confirm swap transaction.
7. Wire activity + notifications + socket events.
8. Integrate `POST /issues` template linkage and fallback defaults.
9. Run build and contract verification checklist.

---

## 17. Done Criteria

Phase 12 is complete when:

- all contract endpoints are implemented and workspace-safe
- defaults are backend-owned and consumed via API
- one-active-template-per-issue-type flow is enforced with explicit confirmation
- one-workspace-default-per-issueType flow is enforced with explicit confirmation
- apply returns draft only and issue creation remains separate
- activity + notification + realtime events are emitted correctly
- DB constraints/indexes and soft-delete behavior are validated
- build passes successfully
