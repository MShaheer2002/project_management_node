# Workflow Configuration Gap Plan

## Purpose

This document defines:

1. what Trussen workflow configuration supports today
2. what is still not configurable
3. how the missing configuration should work in the admin panel
4. what product benefit each upgrade gives
5. how cycle planning should integrate with workflow rules

This is intended as the next product-design and backend-contract reference for workflow expansion.

## Current Flexibility

Today workflow configuration is **workspace-wide** and status-driven.

Each status currently supports:

- `key`
- `label`
- `color`
- `order`
- `isFinal`
- `showOnBoard`

Admins and owners can currently:

- add a new status
- rename a status
- reorder statuses
- change status color
- mark a status as final
- hide a status from board using `showOnBoard = false`

Current backend rules:

- minimum 1 status
- maximum 20 statuses
- key must be lowercase kebab-case
- keys must be unique
- at least one status must be final
- at least one status must stay visible on board
- a status cannot be deleted if issues still use it

## What "List Only" Means Today

The `showOnBoard = false` flag gives a basic **list-only** mode.

Current behavior:

- status is available in issue data
- status can appear in grouped list views
- status is hidden from kanban board columns

This is useful, but still very limited. It solves board clutter, but it does not solve workflow governance.

## What Is Not Configurable Yet

### 1. Transition Rules

Not configurable today:

- which statuses can move to which other statuses
- whether backward moves are allowed
- whether skipping stages is allowed

How it should be configured:

- admin panel should show a **transition matrix**
- each status row should define:
  - allowed next statuses
  - allowed previous statuses
  - whether free movement is allowed

Example:

- `todo -> in-progress`
- `in-progress -> review`
- `review -> done`
- `review -> todo` only if admins allow rollback

Benefit:

- prevents messy workflows
- makes reporting cleaner
- reduces accidental issue movement

Jira-style inspiration:

- explicit workflow transitions
- admin controls how work can move, not only how it is displayed

### 2. Status Categories

Not configurable today:

- status meaning beyond `isFinal`

How it should be configured:

Each status should have a semantic category, for example:

- `backlog`
- `unstarted`
- `active`
- `review`
- `done`
- `cancelled`

Suggested new field:

- `category`

Benefit:

- analytics become more correct
- cycle progress becomes more reliable
- multiple custom labels can still map to one reporting meaning

Example:

- `qa-review`, `design-review`, `client-review` can all map to `review`
- `done`, `released`, `closed` can all map to `done`

Linear-style inspiration:

- simpler semantic state model underneath cleaner UI states

### 3. Role-Based Transition Permission

Not configurable today:

- who can move what

How it should be configured:

Each transition should optionally define allowed actors:

- owner
- admin
- member
- guest
- assignee only
- creator only
- watcher optional

Benefit:

- prevents guests or unrelated members from pushing work into done
- supports approval gates
- makes review stages meaningful

Example:

- only assignee can move `todo -> in-progress`
- only reviewer/admin can move `review -> done`

### 4. Board Visibility Rules Beyond List Only

Not configurable today:

- visible in create form
- visible in filters
- visible in bulk actions
- visible in roadmap/cycle views

How it should be configured:

Each status should support visibility flags:

- `showOnBoard`
- `showInList`
- `showInFilters`
- `showInCreate`
- `showInCycleBoards`

Benefit:

- admin can keep internal/system states hidden
- cleaner create flows
- better separation of operational vs reporting states

Example:

- `triaged` may appear in filters and list, but not in create
- `archived` may appear only in list/history

ClickUp-style inspiration:

- highly flexible status presentation by scope and view

### 5. Default Status by Issue Type

Not configurable today:

- different default workflow start points for task, bug, issue

How it should be configured:

Admin panel should allow:

- default start status for `task`
- default start status for `bug`
- default start status for `issue`

Benefit:

- bugs can start in `triage`
- tasks can start in `todo`
- larger issues can start in `backlog`

### 6. Separate Workflow by Scope

Not configurable today:

- per-project workflow
- per-team workflow
- per-issue-type workflow

Current behavior:

- one workspace workflow for all projects and teams

How it should be configured:

Support workflow inheritance:

1. workspace default workflow
2. optional team override
3. optional project override
4. optional issue-type override

Benefit:

- design team and engineering team can work differently
- support desk workflow does not have to match development workflow
- enterprise customers usually expect this

Recommended rollout:

- phase 1: workspace workflow only
- phase 2: project override
- phase 3: team and issue-type overrides

### 7. Completion Rules

Not configurable today:

- whether an issue is allowed to enter done with incomplete subtasks
- whether due fields are required
- whether acceptance criteria must exist
- whether assignee must exist

How it should be configured:

Each status may optionally define entry rules:

- require assignee
- require due date
- require all subtasks completed
- require acceptance criteria
- require parent issue
- require linked PR or integration ref

Benefit:

- improves quality control
- reduces fake completion
- makes "done" trustworthy

### 8. Approval and Review Gates

Not configurable today:

- formal review stage ownership
- required reviewer approval

How it should be configured:

For review-category statuses, support:

- required reviewer count
- reviewer role restriction
- reviewer group source
  - project members
  - team lead
  - department head
  - manual assignee

Benefit:

- review stages become real workflow stages
- useful for design, QA, release, and client signoff

### 9. Automation Rules

Not configurable today:

- automatic moves based on events
- reminders based on stale states

How it should be configured:

Workflow admin panel should support optional automations:

- when all subtasks complete -> suggest move to done
- when PR merged -> move review to done
- when overdue -> mark as at-risk or notify
- when cycle starts -> move planned backlog items into active starting state

Benefit:

- reduces manual work
- keeps workflow current
- improves AI and reporting quality

### 10. Safe Status Retirement and Migration

Not configurable today:

- merge status into another status
- archive old status safely

How it should be configured:

Before deleting a status that is in use, admin should get options:

- move all issues from old status to new status
- archive status and hide from create/board
- export affected issues list

Benefit:

- safer workflow evolution
- avoids blocked admin actions

## Cycle-Specific Workflow Gaps

Cycles should not be treated as separate from workflow. They need first-class rules.

### What is missing today

- no cycle-specific allowed statuses
- no configured planning status
- no configured active cycle starting status
- no carry-over rule by status category
- no "count toward cycle progress" rule by status category

### How cycle should be configured

Each workflow should define cycle behavior:

- `allowedInCycle`
- `planningBucket`
- `startCycleDefaultStatus`
- `countsAsCompleted`
- `countsAsCarryOver`
- `hideFromCycleBoard`

Recommended cycle settings:

- backlog-category statuses may be planned into a cycle
- list-only statuses may remain visible in cycle list but hidden on cycle board
- done-category statuses count as completed
- cancelled-category statuses should not count as completed
- active/review/backlog states at cycle close should count as carry-over candidates

### Example cycle rules

- `backlog`: can be added to cycle, hidden from board, shown in cycle list
- `todo`: default active-cycle starting state
- `in-progress`: shown on board, counts as open
- `review`: shown on board, counts as open
- `done`: shown on board or optional hidden, counts as complete
- `cancelled`: list only, excluded from velocity

Benefit:

- cycle health becomes accurate
- carry-over becomes predictable
- completed issue counts become trustworthy

Linear-style inspiration:

- cycles are opinionated and work best when the workflow meaning is clear

## Recommended Admin Panel Structure

The admin workflow panel should evolve into these sections.

### 1. Status Library

Fields per status:

- label
- key
- color
- category
- order
- final status toggle
- board/list/filter/create visibility flags
- active/inactive toggle

### 2. Transition Rules

For each status:

- allowed next statuses
- rollback allowed or not
- transition permission by role
- approval required or not

### 3. Validation Rules

Per status entry:

- require assignee
- require due date
- require subtasks complete
- require acceptance criteria
- require reviewer

### 4. Cycle Rules

Per status:

- show in cycle board
- show in cycle list
- counts as carry-over
- counts as complete
- default state when issue is planned

### 5. Scope Overrides

- workspace default
- optional project override
- optional team override later

### 6. Migration Tools

- merge statuses
- replace statuses in bulk
- archive old statuses
- preview affected issues before save

## Recommended Data Model Expansion

Current shape:

```ts
type WorkspaceStatus = {
  key: string;
  label: string;
  color: string;
  order: number;
  isFinal: boolean;
  showOnBoard: boolean;
};
```

Recommended next shape:

```ts
type WorkflowStatus = {
  key: string;
  label: string;
  color: string;
  order: number;
  category: 'backlog' | 'unstarted' | 'active' | 'review' | 'done' | 'cancelled';
  isFinal: boolean;
  isActive: boolean;
  visibility: {
    board: boolean;
    list: boolean;
    filters: boolean;
    create: boolean;
    cycleBoard: boolean;
    cycleList: boolean;
  };
  transitions: {
    to: string[];
    allowRollback: boolean;
    allowedRoles?: Array<'owner' | 'admin' | 'member' | 'guest'>;
    assigneeOnly?: boolean;
  };
  rules: {
    requireAssignee?: boolean;
    requireDueDate?: boolean;
    requireAllSubtasksComplete?: boolean;
    requireAcceptanceCriteria?: boolean;
  };
  cycle: {
    allowedInCycle: boolean;
    countsAsCompleted: boolean;
    countsAsCarryOver: boolean;
    planIntoThisStatus?: boolean;
  };
};
```

## Recommended Rollout Order

### Phase 1

- add `category`
- add richer visibility flags
- add cycle behavior flags

### Phase 2

- add transition matrix
- add role-based transition restrictions

### Phase 3

- add validation rules for entering statuses
- add migration tooling

### Phase 4

- add project-level workflow override
- add workflow templates by department or team

## Expected Product Benefits

If Trussen adds this configuration, the product gets:

- cleaner boards for different teams
- more trustworthy analytics
- more accurate cycle reporting
- better permission control
- better enterprise readiness
- fewer accidental workflow mistakes
- stronger AI suggestions because statuses will carry real meaning
- easier support for bug flow, design flow, sprint flow, and release flow in one platform

## Practical Summary

Today Trussen has:

- customizable statuses
- reorder
- color
- done marker
- list-only board hiding

Trussen does **not** yet have:

- real transition control
- semantic status categories
- entry rules
- role restrictions
- project-specific workflow
- cycle-aware workflow rules
- safe bulk migration tools

The next best upgrade is:

1. semantic categories
2. cycle behavior flags
3. transition matrix
4. status entry rules
5. project-level override

