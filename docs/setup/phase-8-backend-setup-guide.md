# Phase 8 Backend Setup Guide (Activity Feed)

> Phase 8 activity does not require third-party vendors.
> This guide defines backend implementation setup for the global/scoped activity timeline.

---

## 1. Prerequisites

These pieces must already be working:

- Phase 5 issues
- Phase 6 comments
- Phase 7 labels
- workspace auth + role middleware chain
- stable workspace scoping via `X-Workspace-Id`

Required headers for activity routes:

- `Authorization: Bearer <clerk-session-token>`
- `X-Workspace-Id: <workspace-uuid>`

---

## 2. Backend Prerequisites

Activity integration depends on:

- `Activity` model and indexes present in Prisma schema
- activity enum values covering Phase 8 contract types
- routes mounted for activity module
- shared activity logger helper in `shared/utils/activity.ts`

After schema changes:

```bash
npx prisma generate
npx prisma migrate deploy
npm run build
```

---

## 3. Module Structure

Create and keep this structure:

```txt
modules/activity/
├── activity.routes.ts
├── activity.controller.ts
├── activity.service.ts
└── activity.schemas.ts
```

Rule alignment:

- Route -> Middleware -> Controller -> Service -> DB
- no business logic in controller
- all validation via Zod schemas
- all workspace isolation checks in service queries

---

## 4. Route Scope

Implement these routes:

```txt
GET /activity
GET /issues/:issueId/activity
```

`GET /issues/:issueId/activity` is a compatibility route that internally reuses unified activity service filtering by `scope=issue`.

---

## 5. Query Contract

`GET /activity` query:

- `scope?: 'workspace' | 'project' | 'team' | 'issue'`
- `scopeId?: string`
- `actorId?: string`
- `types?: string` (comma-separated)
- `entityTypes?: string` (comma-separated)
- `from?: string` (ISO datetime)
- `to?: string` (ISO datetime)
- `cursor?: string`
- `limit?: number` (default 50, max 100)

Rules:

- `scopeId` is required when scope is `project|team|issue`
- workspace scope is default when `scope` omitted
- newest-first ordering (`createdAt desc`, then `id desc`)
- cursor pagination only

---

## 6. Response Contract

Return standard envelope with list meta:

- `success: true`
- `data: ActivityItem[]`
- `meta: { nextCursor, hasMore }`

Each item must include:

- `id`
- `type`
- `message`
- `createdAt`
- `actor` (`id`, `name`, optional `email`, optional `avatar`)
- `target` (`type`, `id`, optional `entityId`, optional `name`, optional `url`)
- `metadata` (event-specific JSON)

Message is server-generated and deterministic.

---

## 7. Validation Rules

`activity.schemas.ts` must validate:

- allowed scope enum values
- allowed target/entity type enum values
- valid ISO datetimes for `from` and `to`
- `limit` min/max bounds
- comma-list parsing for `types` and `entityTypes`

Reject invalid queries with `422 VALIDATION_ERROR`.

---

## 8. Workspace Isolation Rules

Every activity query MUST include workspace isolation:

- always filter by `workspaceId`
- for scoped feeds (`project|team|issue`) verify scoped entity belongs to same workspace
- never return cross-workspace actor/target rows

For issue compatibility route:

- resolve issue route id using existing issue resolver
- apply workspace filter and issue target filter together

---

## 9. Activity Emission Rules

Activity records are side effects and must be emitted only after primary mutation succeeds.

Use a shared helper (`shared/utils/activity.ts`) from service layer only.

Minimum emit coverage:

- issue create/update transitions
- comment create/edit/delete/mention
- label create/update/delete
- issue label add/remove
- project/team/workspace membership events

Never emit activity from controllers.

---

## 10. Activity Type Coverage

Ensure enum/support exists for contract minimum types:

- `ISSUE_CREATED`
- `ISSUE_TYPE_CHANGED`
- `ISSUE_STATUS_CHANGED`
- `ISSUE_PRIORITY_CHANGED`
- `ISSUE_ASSIGNEE_CHANGED`
- `ISSUE_DUE_DATE_CHANGED`
- `ISSUE_SCOPE_CHANGED`
- `ISSUE_ARCHIVED`
- `COMMENT_CREATED`
- `COMMENT_EDITED`
- `COMMENT_DELETED`
- `COMMENT_MENTIONED`
- `PROJECT_CREATED`
- `PROJECT_UPDATED`
- `PROJECT_MEMBER_ADDED`
- `PROJECT_MEMBER_REMOVED`
- `TEAM_MEMBER_JOINED`
- `TEAM_MEMBER_REMOVED`
- `TEAM_MEMBER_ROLE_CHANGED`
- `WORKSPACE_MEMBER_JOINED`
- `WORKSPACE_MEMBER_REMOVED`

If existing enum names differ, map at API boundary to contract-safe values.

---

## 10.1 Detailed Activity Matrix (Required)

Each activity type below must define trigger, target shape, minimum metadata, and deterministic message template.

### Issue lifecycle

- `ISSUE_CREATED`
  - trigger: issue create succeeds
  - target: `type=issue`, `id=<issueId>`
  - metadata: `entityId`, `entityTitle`, `url`, `projectId`, `teamId`
  - message template: `"{actor} created issue {entityId}"`

- `ISSUE_TYPE_CHANGED`
  - trigger: issue type changes (`task|bug|issue`)
  - metadata: `fromType`, `toType`, `entityId`, `url`
  - message template: `"{actor} changed type of {entityId} from {fromType} to {toType}"`

- `ISSUE_STATUS_CHANGED`
  - trigger: status update route or patch changing status
  - metadata: `fromStatus`, `toStatus`, `entityId`, `url`
  - message template: `"{actor} moved {entityId} from {fromStatus} to {toStatus}"`

- `ISSUE_PRIORITY_CHANGED`
  - trigger: priority field changes
  - metadata: `fromPriority`, `toPriority`, `entityId`, `url`
  - message template: `"{actor} changed priority of {entityId} from {fromPriority} to {toPriority}"`

- `ISSUE_ASSIGNEE_CHANGED`
  - trigger: assignee set/changed/cleared
  - metadata: `fromAssignee`, `toAssignee`, `entityId`, `url`
  - message template: `"{actor} changed assignee of {entityId}"`

- `ISSUE_DUE_DATE_CHANGED`
  - trigger: due date set/changed/cleared
  - metadata: `fromDueDate`, `toDueDate`, `entityId`, `url`
  - message template: `"{actor} updated due date of {entityId}"`

- `ISSUE_SCOPE_CHANGED`
  - trigger: issue moved across project or team
  - metadata: `fromProject`, `toProject`, `fromTeam`, `toTeam`, `entityId`, `url`
  - message template: `"{actor} moved {entityId} to a different scope"`

- `ISSUE_ARCHIVED`
  - trigger: archive/soft-complete workflow action (if supported)
  - metadata: `entityId`, `url`
  - message template: `"{actor} archived {entityId}"`

### Comment and collaboration

- `COMMENT_CREATED`
  - trigger: comment create succeeds
  - target: `type=comment`, `id=<commentId>`, parent issue in metadata
  - metadata: `commentId`, `commentExcerpt`, `parentCommentId`, `entityId`, `url`
  - message template: `"{actor} commented on {entityId}"`

- `COMMENT_EDITED`
  - trigger: comment update succeeds
  - metadata: `commentId`, `commentExcerpt`, `entityId`, `url`
  - message template: `"{actor} edited a comment on {entityId}"`

- `COMMENT_DELETED`
  - trigger: comment delete succeeds
  - metadata: `commentId`, `entityId`, `url`
  - message template: `"{actor} deleted a comment on {entityId}"`

- `COMMENT_MENTIONED`
  - trigger: mention extracted and persisted
  - metadata: `commentId`, `targetUserId`, `targetUserName`, `entityId`, `url`
  - message template: `"{actor} mentioned {targetUserName} on {entityId}"`

### Label and taxonomy

- `LABEL_CREATED`
  - trigger: label create succeeds
  - target: `type=label`, `id=<labelId>`
  - metadata: `labelId`, `labelName`, `color`
  - message template: `"{actor} created label {labelName}"`

- `LABEL_UPDATED`
  - trigger: label update succeeds
  - metadata: `labelId`, `labelName`, `fromColor`, `toColor`, `fromName`, `toName`
  - message template: `"{actor} updated label {labelName}"`

- `LABEL_DELETED`
  - trigger: label delete succeeds
  - metadata: `labelId`, `labelName`
  - message template: `"{actor} deleted label {labelName}"`

- `ISSUE_LABEL_ADDED`
  - trigger: labels attached to issue
  - metadata: `entityId`, `labelIds`, `labelNames`, `url`
  - message template: `"{actor} added label(s) to {entityId}"`

- `ISSUE_LABEL_REMOVED`
  - trigger: label removed from issue
  - metadata: `entityId`, `labelId`, `labelName`, `url`
  - message template: `"{actor} removed a label from {entityId}"`

### Project/team/workspace membership

- `PROJECT_CREATED`
  - trigger: project create succeeds
  - target: `type=project`, `id=<projectId>`
  - metadata: `projectId`, `projectName`, `url`
  - message template: `"{actor} created project {projectName}"`

- `PROJECT_UPDATED`
  - trigger: project fields updated
  - metadata: `projectId`, `projectName`, `changedFields`, `url`
  - message template: `"{actor} updated project {projectName}"`

- `PROJECT_MEMBER_ADDED`
  - trigger: member added to project
  - metadata: `projectId`, `member`, `roleAfter`, `url`
  - message template: `"{actor} added {member.name} to project"`

- `PROJECT_MEMBER_REMOVED`
  - trigger: member removed from project
  - metadata: `projectId`, `member`, `url`
  - message template: `"{actor} removed {member.name} from project"`

- `TEAM_MEMBER_JOINED`
  - trigger: member added to team
  - metadata: `teamId`, `member`, `url`
  - message template: `"{actor} added {member.name} to team"`

- `TEAM_MEMBER_REMOVED`
  - trigger: member removed from team
  - metadata: `teamId`, `member`, `url`
  - message template: `"{actor} removed {member.name} from team"`

- `TEAM_MEMBER_ROLE_CHANGED`
  - trigger: team role changed
  - metadata: `teamId`, `member`, `roleBefore`, `roleAfter`, `url`
  - message template: `"{actor} changed role of {member.name} in team"`

- `WORKSPACE_MEMBER_JOINED`
  - trigger: invitation accepted / member joined
  - target: `type=member`, `id=<memberUserId>`
  - metadata: `member`, `workspaceId`
  - message template: `"{member.name} joined the workspace"`

- `WORKSPACE_MEMBER_REMOVED`
  - trigger: member removed from workspace
  - metadata: `member`, `workspaceId`
  - message template: `"{actor} removed {member.name} from workspace"`

Guideline:
- If one request mutates multiple fields, emit one activity per semantic change type.
- All emitted records must include `workspaceId`, `actorId` (or system marker), `type`, `targetType`, `targetId`, `message`, `createdAt`.

---

## 11. Metadata Contract

Standard metadata keys to keep stable:

Common:

- `entityId`
- `entityTitle`
- `url`

Status changes:

- `fromStatus`
- `toStatus`

Assignment:

- `fromAssignee`
- `toAssignee`

Scope changes:

- `fromProject`, `toProject`
- `fromTeam`, `toTeam`

Comments:

- `commentId`
- `commentExcerpt` (max 140 chars)
- `parentCommentId`

Membership:

- `member`
- `roleBefore`
- `roleAfter`

Unknown metadata keys must be tolerated by frontend.

---

## 12. Performance Setup

Use/verify indexes:

- `(workspaceId, createdAt DESC)`
- `(workspaceId, targetType, targetId, createdAt DESC)`
- `(workspaceId, actorId, createdAt DESC)`
- `(workspaceId, type, createdAt DESC)`

Requirements:

- cursor pagination without duplicate rows across pages
- predictable ordering for equal timestamps using secondary key (`id`)

---

## 13. Error Handling

Use consistent codes:

- `FORBIDDEN`
- `VALIDATION_ERROR`
- `ISSUE_NOT_FOUND` (for issue compatibility route)
- `NOT_FOUND` (generic missing scope entity if no specific code exists)

Return standard envelope from global error handler.

---

## 14. App Wiring

In `app/app.ts` mount activity routes when module is implemented:

```ts
app.use(activityRoutes);
```

Also update OpenAPI paths/schemas once route implementation is live.

---

## 15. Frontend Readiness Checklist

Frontend should be ready for:

- global `/activity` infinite list
- project/team/issue scoped activity tabs
- actor avatar + name rendering
- type badge mapping
- server `message` display
- relative timestamp from `createdAt`
- deep links via `target.url`

---

## 16. Done-When Checklist

- [ ] Activity module routes/controllers/services/schemas implemented
- [ ] Unified `GET /activity` supports scope + filters + cursor pagination
- [ ] `GET /issues/:issueId/activity` compatibility route implemented via shared service
- [ ] Workspace isolation enforced in every query
- [ ] Activity records emitted from domain services after successful mutations
- [ ] Stable metadata + message contract returned for FE timeline rendering
- [ ] Build passes and API behavior verified with manual requests
