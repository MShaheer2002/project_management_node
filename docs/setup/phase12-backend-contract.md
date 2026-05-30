# Phase 12 Backend Contract (Templates)

This document translates Phase 12 from [build-phases.md](./build-phases.md) into a production-grade backend contract for issue templates.

Phase 0 through Phase 11 are assumed complete.

## Goal

Deliver workspace-scoped issue templates as reusable blueprints for creating issues consistently across the app.

Templates are issue templates only.

They are not project templates.
They are not team templates.
They are not workspace templates.

Templates must allow each workspace to define:

- category options
- priority options
- status options
- default labels
- issue body structure
- checklist/subtasks
- severity and issue-specific metadata
- an active template for a given issue type

The backend must own the source of truth for:

- default category options
- default priority options
- default status options
- default label options
- default selected values for new templates
- active template state
- template application behavior
- issue draft generation from templates
- template ownership and scope assignment

The frontend must never hardcode these lists.

## Business Goal

Teams repeatedly create similar issues:

- bug reports
- feature requests
- technical tasks
- QA validation tasks
- research spikes
- security reviews
- release activities
- onboarding tasks

Without templates, users manually rebuild the same issue structure every time.

Templates solve that by providing reusable, editable issue blueprints.

When a user applies a template:

- the backend returns a generated issue draft
- the frontend lets the user review and modify the draft
- the issue is not created until the user confirms

## Dependency and Scope

Depends on:

- Phase 3: workspaces, teams, departments, roles
- Phase 4: projects
- Phase 5: issues
- Phase 8: activity
- Phase 9: notifications
- Phase 10: realtime sockets
- Phase 11: cycles

In scope:

- template database model
- template defaults catalog
- per-template category/priority/status/label option banks
- template CRUD
- template activation and deactivation
- active template conflict handling
- owner/admin-only template management
- workspace/team/project template scopes
- issue draft generation from templates
- issue creation fallback when no template is applied
- template activity events
- template notifications
- socket updates for template changes

Out of scope:

- project templates
- team templates
- workflow automation
- recurring issue generation
- billing rules for templates

## Frontend Surfaces Impacted

- template list page: `src/pages/TemplatesPage.tsx`
- template create/edit page: `src/pages/TemplatesPage.tsx`
- template detail page: `src/pages/TemplatesPage.tsx`
- issue create flow: apply template before issue creation
- issue detail page: template-derived metadata display
- activity feeds for template operations
- notification inbox for template operations
- realtime notifications after template activation or update

## Core Concept

Template = Blueprint

Issue = Real work item

Applying a template never mutates the template.

Applying a template produces an issue draft only.

The user still has to confirm creation.

Templates are reusable indefinitely.

## Domain Model

## Template Option Banks

The backend owns the available values for the template editor and list filters.

```ts
type TemplateDefaults = {
  categoryOptions: string[];
  priorityOptions: string[];
  statusOptions: string[];
  labelOptions: string[];
};
```

These defaults are returned by the backend and used to seed new templates.

The backend may allow workspace-level customization of these defaults later.
The frontend must always request them from the API.

## Template Ownership and Scope

Only `owner` and `admin` can create, edit, delete, duplicate, activate, deactivate, or change the default/scope state of a template.

`member` and `guest` can view and apply templates if the template is visible to them.

Each template belongs to exactly one scope:

```ts
type TemplateScopeType = 'WORKSPACE' | 'TEAM' | 'PROJECT';

type TemplateScope = {
  scopeType: TemplateScopeType;
  scopeId: string | null;
};
```

Scope rules:

- `WORKSPACE`: global workspace template
- `TEAM`: template assigned to one team
- `PROJECT`: template assigned to one project

The create/edit UI must present three choices:

1. Workspace default
2. Team template
3. Project template

When `TEAM` or `PROJECT` is selected, the frontend should open a scoped search dialog to pick the team/project.

Backend validation:

- `TEAM` requires a valid `teamId` in `scopeId`
- `PROJECT` requires a valid `projectId` in `scopeId`
- `WORKSPACE` must use `scopeId = null`

## Default Template Rules

Only workspace-scoped templates can be marked as the default template for a given `issueType`.

```ts
type TemplateDefaultState = {
  isDefault: boolean;
  issueType: TemplateIssueType;
};
```

Rules:

- at most one workspace default template may exist per `issueType`
- team-scoped and project-scoped templates are not workspace defaults
- when saving a workspace default template that would conflict with an existing default for the same `issueType`, the backend must return a conflict response with confirmation details

Recommended conflict response:

```ts
type TemplateDefaultConflictError = {
  code: 'TEMPLATE_DEFAULT_CONFLICT';
  message: string;
  details: {
    issueType: TemplateIssueType;
    currentDefault: { id: string; name: string };
    candidateTemplate: { id: string; name: string };
    scopeType: 'WORKSPACE';
    requiresConfirmation: true;
  };
};
```

On explicit confirmation, backend behavior must be atomic:

- demote the previous workspace default for that `issueType`
- promote the candidate template as the new workspace default
- emit activity and socket events for both templates

## Effective Template Precedence

When more than one template exists for the same `issueType`, the backend must resolve the effective template in this order:

1. project-scoped template for the current project
2. team-scoped template for the current team
3. workspace-scoped template for the workspace
4. no template

This precedence applies to:

- template auto-selection in issue creation
- the active template catalog
- the visibility of the `Apply template` action in the issue create flow

Rules:

- if a project template exists for the current project and issue type, it wins over team and workspace templates
- if no project template exists, a team template for the current team and issue type wins over workspace templates
- if neither project nor team templates exist, the workspace template for that issue type is used
- if no template exists at any scope, the issue create flow must fall back to backend defaults

The backend should return the effective template together with its scope so the frontend can hide the apply action for contexts that already have an assigned template.

## Persisted Assignment State

Template assignment must be persisted in the database on the template record itself.

That means:

- `scopeType` and `scopeId` define where the template belongs
- `isActive` defines whether the template is currently the selected template for its scope and issue type
- `isDefault` is only valid for workspace-scoped templates and only represents the workspace default for that issue type

Frontend rules driven by backend state:

- if a template is already active for the current team/project/workspace and issue type, the UI must not keep showing the `Apply template` action for that context
- the UI should only show `Apply template` again after the template is deactivated or another template becomes active for that same scope and issue type
- the active template catalog is the source of truth for this visibility

## Template Category

Categories are workspace-defined labels for template classification.

Examples:

- Bug
- Feature
- Task
- QA
- Research
- Security
- Release
- Onboarding

A template can also define a custom category.

```ts
type TemplateCategory = string;
```

The backend should not hardcode the category list in the UI contract.

## Template Status

Statuses are workspace-defined template defaults and can include custom labels.

The issue system may still have standard workflow statuses, but the template layer must support per-template status configuration.

```ts
type TemplateStatusValue = string;
```

If a template has a custom status label, that label must be displayed alongside or in place of the base workflow status in template views and generated issue drafts, according to the issue model rules.

## Template Priority

Priorities are template-defined and can include custom labels.

The backend must seed at least:

- low
- medium
- high
- urgent

```ts
type TemplatePriorityValue = string;
```

## Template Label

Labels are template-defined reusable tags.

Examples:

- bug
- feature
- task
- qa
- security
- release

```ts
type TemplateLabelValue = string;
```

## Template

```ts
type TemplateAssigneeType = 'UNASSIGNED' | 'CREATOR' | 'SPECIFIC_USER';
type TemplateIssueType = 'task' | 'bug' | 'issue';
type TemplateLifecycle = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

type Template = {
  id: string; // uuid
  workspaceId: string;
  name: string;
  description: string;

  issueType: TemplateIssueType;
  scopeType: 'WORKSPACE' | 'TEAM' | 'PROJECT';
  scopeId: string | null;
  isDefault: boolean;
  category: string;
  customCategory: string | null;

  titleTemplate: string;
  contentTemplate: string;

  defaultPriority: string;
  defaultStatus: string;
  customStatus: string | null;
  defaultAssigneeType: TemplateAssigneeType;
  defaultAssigneeId: string | null;
  defaultEstimate: number | null;
  defaultDueDateOffset: number | null;
  defaultLabelIds: string[];
  defaultSeverity: 'low' | 'medium' | 'high' | null;

  categoryOptions: string[];
  priorityOptions: string[];
  statusOptions: string[];
  labelOptions: string[];

  checklistItems: string[];
  stepsToReproduceTemplate: string | null;
  expectedBehaviorTemplate: string | null;
  actualBehaviorTemplate: string | null;
  acceptanceCriteriaTemplate: string | null;
  relatedIssueKeysTemplate: string | null;
  notesTemplate: string | null;

  lifecycle: TemplateLifecycle;
  isActive: boolean;
  activeVersion: number;

  usageCount: number;
  timesApplied: number;
  lastAppliedAt: string | null;

  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
```

## Template Draft Input

This is the payload used for create/update.

```ts
type TemplateDraftInput = {
  name: string;
  description: string;

  issueType: TemplateIssueType;
  scopeType: 'WORKSPACE' | 'TEAM' | 'PROJECT';
  scopeId: string | null;
  isDefault: boolean;
  category: string;
  customCategory: string | null;

  titleTemplate: string;
  contentTemplate: string;

  defaultPriority: string;
  defaultStatus: string;
  customStatus: string | null;
  defaultAssigneeType: TemplateAssigneeType;
  defaultAssigneeId: string | null;
  defaultEstimate: number | null;
  defaultDueDateOffset: number | null;
  defaultLabelIds: string[];
  defaultSeverity: 'low' | 'medium' | 'high' | null;

  categoryOptions: string[];
  priorityOptions: string[];
  statusOptions: string[];
  labelOptions: string[];

  checklistItems: string[];
  stepsToReproduceTemplate: string | null;
  expectedBehaviorTemplate: string | null;
  actualBehaviorTemplate: string | null;
  acceptanceCriteriaTemplate: string | null;
  relatedIssueKeysTemplate: string | null;
  notesTemplate: string | null;
};
```

## Template Apply Draft

Applying a template returns a draft that the frontend can use to seed the issue creation form.

```ts
type TemplateApplyDraft = {
  templateId: string;
  title: string;
  description: string;
  issueType: TemplateIssueType;
  scopeType: 'WORKSPACE' | 'TEAM' | 'PROJECT';
  scopeId: string | null;
  isDefault: boolean;
  priority: string;
  status: string;
  customStatus: string | null;
  assigneeType: TemplateAssigneeType;
  assigneeId: string | null;
  estimate: number | null;
  dueDateOffset: number | null;
  labels: string[];
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

## API Surface

All endpoints use the existing API response format:

```json
{
  "success": true,
  "data": {}
}
```

Errors:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": []
  }
}
```

## Defaults and Catalog Endpoints

### Get template defaults

Returns the backend-owned option banks used by the template editor and list filters.

```http
GET /templates/defaults
```

Response:

```ts
{
  categoryOptions: string[];
  priorityOptions: string[];
  statusOptions: string[];
  labelOptions: string[];
}
```

Rules:

- this is the source of truth for the frontend
- new template forms must request this endpoint before rendering editable option banks
- the response should include a sensible default seed set if the workspace has not customized anything yet

### Get active template catalog

Returns active templates grouped by issue type for use in issue creation flows.

```http
GET /templates/active
```

Query options:

- `workspaceId`
- `teamId` optional
- `projectId` optional
- `issueType` optional

Response expectations:

- the backend must return the effective active template for the requested context
- each item must include `scopeType`, `scopeId`, `issueType`, `isActive`, `isDefault`, `appliedByCurrentUser`, and `appliedAt`
- the frontend uses this response as the source of truth for whether the `Apply template` action should be shown for a given context

## Template CRUD Endpoints

### List templates

```http
GET /templates
```

Query:

- `q`
- `category`
- `issueType`
- `scopeType`
- `scopeId`
- `creatorId`
- `sort`
- `lifecycle`
- `isActive`

The list must be workspace scoped.

### Get template detail

```http
GET /templates/:id
```

Returns:

- template core fields
- usage stats
- option banks
- creator metadata
- activation metadata
- application metadata for the current user:
  - `appliedByCurrentUser`
  - `appliedAt`
  - `appliedDraft` if the backend stores the last applied draft

### Create template

```http
POST /templates
```

Behavior:

- if the request omits category/priority/status/label option banks, the backend must seed them from `/templates/defaults`
- if the request omits default selected values, the backend must pick the workspace defaults
- the template becomes an independent record with its own option banks
- the template must be created with exactly one scope:
  - workspace default
  - team template
  - project template
- owner/admin only can submit this mutation

Validation:

- `name` required
- `description` required
- `contentTemplate` required
- `issueType` required
- `scopeType` required
- `scopeId` required for `TEAM` and `PROJECT`
- `scopeId` must be null for `WORKSPACE`
- `category` required
- `defaultPriority` required
- `defaultStatus` required
- `defaultLabelIds` may be empty
- `defaultAssigneeType` must match the template assignee rules
- bug templates should require bug metadata where applicable
- issue templates must support acceptance criteria if your issue model requires it
- if `scopeType = WORKSPACE` and `isDefault = true`, the backend must enforce the one-default-per-issueType rule
- if another workspace default already exists for the same `issueType`, return a confirmation conflict response

### Update template

```http
PATCH /templates/:id
```

Behavior:

- updates the template record only
- existing issues already created from the template are not modified
- changes to option banks affect future template use only
- scope changes must respect the same validation rules as create
- setting `isDefault = true` on a workspace template must enforce the one-default-per-issueType rule

### Delete template

```http
DELETE /templates/:id
```

Recommended behavior:

- soft delete
- preserve historical usage in activity and analytics
- keep already generated issues untouched

### Duplicate template

```http
POST /templates/:id/duplicate
```

Creates a new template cloned from the source template.

Important:

- duplicated template gets new id
- `usageCount` resets to 0
- `isActive` defaults to false unless explicitly requested otherwise

### Apply template

```http
POST /templates/:id/apply
```

This endpoint must not create the issue.

It generates an issue draft and must persist template-application state for the current user and workspace.

The returned payload should include:

- `draft` with the issue draft
- `appliedByCurrentUser: true`
- `appliedAt`
- `templateId`
- `scopeType`
- `scopeId`

If the backend stores the last applied draft, it should also return:

- `appliedDraft` (same draft snapshot for the current user)

This state is the source of truth for hiding the `Apply template` CTA when the user returns to the template later.

## Active Template Rules

Templates can be active or inactive.

The app needs to support a safe activation flow.

### One active template per scope and issue type

For each exact scope key, the backend must keep at most one active template per `issueType`.

Scope keys are:

- workspace + issue type
- team + issue type
- project + issue type

If a bug template is already active for the same scope and issue type and the user tries to activate another bug template in that same scope:

- backend must return a conflict response
- frontend must show a confirmation prompt
- prompt text should explain that one active template already exists for that scope
- the user can choose:
  - yes, deactivate the current one and activate the new one
  - no, cancel the operation

This gives predictable issue creation behavior while still allowing:

- one active workspace template per issue type
- one active team template per issue type per team
- one active project template per issue type per project

### Activation endpoint

```http
POST /templates/:id/activate
```

If no active template exists for that issue type:

- activate immediately

If another active template exists for the same issue type:

- return `409 CONFLICT`
- include the conflicting template and a confirmation payload

Example conflict response:

```json
{
  "success": false,
  "error": {
    "code": "TEMPLATE_ALREADY_ACTIVE",
    "message": "A bug template is already active. Do you want to deactivate it and activate this template instead?",
    "details": {
      "issueType": "bug",
      "activeTemplate": {
        "id": "tpl-bug-report",
        "name": "Bug Report"
      },
      "candidateTemplate": {
        "id": "tpl-bug-triage",
        "name": "Bug Triage"
      },
      "requiresConfirmation": true
    }
  }
}
```

### Confirm activation swap

```http
POST /templates/:id/activate/confirm
```

Behavior:

- deactivate the currently active template for that issue type
- activate the requested template
- emit activity, notification, and socket updates

### Deactivate template

```http
POST /templates/:id/deactivate
```

Behavior:

- marks the template inactive
- does not delete it
- does not affect existing issues

## Default Selection Rules For New Template

When creating a new template, the backend must populate:

- category options
- priority options
- status options
- label options

from the backend defaults endpoint or workspace settings.

The create form should receive a template-shaped payload with:

- default category selected
- default priority selected
- default status selected
- default labels selected

The save dialog must support three scope choices:

1. workspace default
2. team template
3. project template

If the user selects team or project scope, the frontend opens a searchable dialog to pick the target team/project before save.

If the workspace has no custom values yet, the backend should provide the seed defaults:

- category: `Bug`, `Feature`, `Task`, `QA`, `Research`, `Security`, `Release`, `Onboarding`
- priority: `low`, `medium`, `high`, `urgent`
- status: `backlog`, `todo`, `in-progress`, `review`, `done`
- labels: `bug`, `feature`, `task`, `qa`, `research`, `security`, `release`, `onboarding`, `review`, `product`

These values belong to backend seed data, not frontend code.

### Default swap on save

If the user marks a workspace template as default for a given issue type and another workspace default already exists for the same issue type:

- backend must return a conflict response with the current default and the candidate template
- frontend must show a confirmation dialog
- dialog copy should explain:
  - "Do you want to make this template default and revert the previous one?"
- on confirm, backend must demote the old default and promote the new one atomically

Recommended response:

```json
{
  "success": false,
  "error": {
    "code": "TEMPLATE_DEFAULT_CONFLICT",
    "message": "A workspace default template already exists for bug issues. Do you want to replace it?",
    "details": {
      "issueType": "bug",
      "currentDefault": {
        "id": "tpl-bug-report",
        "name": "Bug Report"
      },
      "candidateTemplate": {
        "id": "tpl-bug-triage",
        "name": "Bug Triage"
      },
      "scopeType": "WORKSPACE",
      "requiresConfirmation": true
    }
  }
}
```

## Issue Creation Rules

When a user creates a new issue:

- if a template is selected, the backend should supply the issue draft from `/templates/:id/apply`
- if no template is selected, the backend must still supply safe defaults for issue type, priority, status, labels, and any other required fields
- templates must map into issue create payloads consistently across bug, task, and issue flows
- when multiple templates exist for the same issue type, the backend should resolve the best match using scope precedence:
  - project-scoped template
  - team-scoped template
  - workspace default template

### Fallback behavior when no template is applied

If the user does not pick a template:

- use the backend's default issue type
- use the backend's default priority
- use the backend's default status
- use the backend's default labels if configured
- use issue-type-specific defaults where required

### Template-derived issue creation

The issue create endpoint should accept a template draft payload or a template id reference.

Recommended:

```http
POST /issues
```

Payload may include:

- `templateId`
- `templateDraftId` optional
- `title`
- `description`
- `type`
- `priority`
- `status`
- `customStatus`
- `selectedLabelIds`
- `assigneeId`
- `estimate`
- `dueDate`
- `severity`
- `acceptanceCriteria`
- `stepsToReproduce`
- `relatedIssues`
- `notes`

If `templateId` is present:

- backend should preserve the linkage in issue metadata
- activity should record the template source

## Expected Error Codes

Template mutations should use clear backend codes:

- `TEMPLATE_NOT_FOUND`
- `TEMPLATE_ALREADY_ACTIVE`
- `TEMPLATE_ACTIVATION_CONFLICT`
- `TEMPLATE_DEFAULT_CONFLICT`
- `TEMPLATE_VALIDATION_FAILED`
- `VALIDATION_ERROR`
- `FORBIDDEN`
- `ASSIGNEE_NOT_WORKSPACE_MEMBER`
- `LABEL_NOT_FOUND`

## Activity Rules

Every template operation should emit activity events:

- template created
- template updated
- template deleted
- template activated
- template deactivated
- template applied

If a template is applied and then turned into a real issue:

- activity should record both the template application and the issue creation

## Notification Rules

Templates should trigger notifications where relevant:

- a user is mentioned in a template-related discussion
- a template is activated by another admin/owner
- a template is updated and affects active workflow
- a template is deleted while still referenced by a user flow

Notifications should be workspace scoped and role aware.

## Realtime Socket Rules

When templates change:

- broadcast create/update/delete/activate/deactivate events to the workspace room
- update template list and detail views live
- refresh active template status live

Suggested socket event names:

- `template.created`
- `template.updated`
- `template.deleted`
- `template.activated`
- `template.deactivated`

Payload should include:

- `workspaceId`
- `templateId`
- `issueType`
- `isActive`
- `updatedAt`

## Permissions

Use existing authentication and workspace guards.

| Action | Owner | Admin | Member | Guest |
|---|---:|---:|---:|---:|
| List/view templates | Yes | Yes | Yes | Yes |
| View template detail | Yes | Yes | Yes | Yes |
| Create template | Yes | Yes | No | No |
| Edit template | Yes | Yes | No | No |
| Delete template | Yes | Yes | No | No |
| Activate/deactivate template | Yes | Yes | No | No |
| Apply template to issue draft | Yes | Yes | Yes | Optional |

Recommended contextual rule:

- owners and admins manage template definitions
- members can apply templates if allowed by workspace policy
- guests are read-only unless explicitly granted apply access

## Validation Rules

### Create/update validation

- `name` must be non-empty
- `description` must be non-empty
- `contentTemplate` must be non-empty
- `issueType` must be valid
- `scopeType` must be valid
- `scopeId` must match the selected scope type
- `defaultPriority` must be from the template priority options
- `defaultStatus` must be from the template status options
- `defaultLabelIds` must reference values in the template label options or workspace labels
- custom category/status values must be preserved and displayed correctly
- workspace default templates must enforce one default per issue type

### Active template validation

- only one active template per scope and issue type
- activation swap must be explicit
- the backend must never silently deactivate another template without confirmation

### Issue conversion validation

- bug templates must carry bug-specific metadata when used
- issue templates should require acceptance criteria if the issue model or workflow requires it
- task templates may omit bug-specific fields

## Suggested Database Model

```prisma
model Template {
  id                    String          @id @default(uuid())
  workspaceId           String
  name                  String
  description           String
  issueType             String
  scopeType             String          @default("WORKSPACE")
  scopeId               String?
  isDefault             Boolean         @default(false)
  category              String
  customCategory        String?
  titleTemplate         String
  contentTemplate       String
  defaultPriority       String
  defaultStatus         String
  customStatus          String?
  defaultAssigneeType   String
  defaultAssigneeId     String?
  defaultEstimate       Int?
  defaultDueDateOffset  Int?
  defaultSeverity       String?
  defaultLabelIds       String[]
  categoryOptions       String[]
  priorityOptions       String[]
  statusOptions         String[]
  labelOptions          String[]
  checklistItems        String[]
  stepsToReproduceTemplate   String?
  expectedBehaviorTemplate   String?
  actualBehaviorTemplate     String?
  acceptanceCriteriaTemplate String?
  relatedIssueKeysTemplate   String?
  notesTemplate         String?
  lifecycle             String          @default("ACTIVE")
  isActive              Boolean         @default(false)
  activeVersion         Int             @default(1)
  usageCount            Int             @default(0)
  timesApplied          Int             @default(0)
  lastAppliedAt         DateTime?
  createdById           String
  updatedById           String?
  createdAt             DateTime        @default(now())
  updatedAt             DateTime        @updatedAt
  deletedAt             DateTime?

  @@index([workspaceId, issueType])
  @@index([workspaceId, scopeType, scopeId])
  @@index([workspaceId, isActive])
  @@index([workspaceId, lifecycle])
}
```

## Suggested Implementation Notes

- keep option banks on the template record itself
- seed new templates from `/templates/defaults`
- use a confirmation flow for activation swaps
- persist custom category/status values on the template record
- when the user applies a template, generate a draft first, not a live issue
- preserve template-linked metadata in issue history and activity

## Not In Scope

This phase does not require:

- project-level blueprints
- team-level blueprints
- automation rules
- recurring template execution
- billing integration
- template analytics dashboards beyond basic usage count and last used data

## Summary

Phase 12 makes templates a backend-owned, workspace-scoped issue blueprint system.

The backend must own:

- defaults
- option banks
- activation rules
- conflict resolution
- draft generation

The frontend should only render and consume these rules.
