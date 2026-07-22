# Workflow Configuration Phase Tracker

## Purpose

This document is the execution companion to [workflow-configuration-gap-plan.md](./workflow-configuration-gap-plan.md).

It divides the workflow work into:

1. completed phases
2. partially completed phases
3. remaining phases
4. what each phase gives the product
5. what to do next
6. what not to do yet

Use this as the implementation tracker so no workflow scope is forgotten while shipping the system.

## Current Snapshot

As of July 16, 2026:

- the workspace-level workflow model is now much richer than the original system
- workflow statuses support category, visibility, cycle behavior, permissions, validation rules, and active/inactive lifecycle
- workflow automation has started and is no longer just a future concept
- the largest missing capability is still workflow override by scope

## Phase Status Overview

### Completed / Largely Completed

#### Phase 1. Status Model Expansion

Status: Completed

Implemented:

- `category`
- `isActive`
- richer `visibility`
- richer `cycle`
- richer `transitions`
- richer `rules`
- normalization/defaulting on backend
- normalization/defaulting on frontend

Benefit:

- workflow is now semantic, not only visual
- cycle reporting can use real workflow meaning
- system states can be hidden without deleting them
- later automation and approval logic has a stronger base

#### Phase 2. Visibility and Presentation Controls

Status: Completed

Implemented:

- board visibility
- list visibility
- filter visibility
- create-form visibility
- cycle board visibility
- cycle list visibility
- inactive statuses automatically removed from operational surfaces

Benefit:

- cleaner issue create flow
- cleaner board views
- less clutter from internal or retired states
- better separation between operational states and historical states

#### Phase 3. Transition Rules

Status: Mostly completed

Implemented:

- free vs restricted movement
- allowed next states
- role-based movement rules
- assignee-only gate
- creator-only gate

Still missing in this phase:

- clearer rollback semantics as a first-class admin concept
- more polished transition UX for large workflows

Benefit:

- reduces accidental movement
- makes workflows enforceable instead of cosmetic
- improves reporting trustworthiness

#### Phase 4. Completion / Entry Validation Rules

Status: Completed

Implemented:

- require assignee
- require due date
- require all subtasks complete
- require acceptance criteria
- require parent issue
- require integration reference

Benefit:

- “done” and review stages become meaningful
- low-quality issue movement is reduced
- teams can enforce quality without manual policing

#### Phase 5. Cycle Workflow Rules

Status: Mostly completed

Implemented:

- `allowedInCycle`
- `countsAsCompleted`
- `countsAsCarryOver`
- `planIntoThisStatus`
- cycle planning integration
- cycle-start automation hook

Still missing in this phase:

- broader scope-aware cycle behavior once project overrides exist

Benefit:

- cycle progress is more accurate
- carry-over becomes predictable
- planned work can land in the correct operational status

#### Phase 6. Safe Status Retirement

Status: Mostly completed

Implemented:

- status usage lookup
- preview of affected issues
- move issues to another workflow before removal
- delete issues with the workflow if explicitly chosen
- inactive/archive-style workflow handling

Still missing in this phase:

- real export of affected issues
- dedicated merge-status tooling

Benefit:

- admins can evolve workflow safely
- old statuses do not block future workflow refinement
- issue data is less likely to be damaged during admin changes

#### Phase 7. Workflow Automation Foundation

Status: Partially completed

Implemented:

- subtask completion automation
- cycle-start automation
- overdue notification automation
- GitHub PR opened automation
- GitHub PR merged automation
- workspace-level automation configuration panel

Still missing in this phase:

- deeper stale-state / at-risk automation
- richer suggestion vs automatic move behavior
- stronger review-oriented automation

Benefit:

- reduces repeated manual workflow work
- keeps issues closer to their real lifecycle state
- gives AI and analytics more trustworthy workflow data

## Not Completed Yet

### Phase 8. Scope Overrides

Status: Not started

Needs to be implemented:

- workspace default workflow
- optional project workflow override
- optional team workflow override
- issue flows must resolve the effective workflow correctly

Recommended rollout:

1. workspace default
2. project override
3. team override
4. issue-type override only if still needed later

Benefit:

- different projects can use different workflows without polluting the whole workspace
- design, engineering, support, and operations can all work differently
- enterprise customers expect this

This should be done next because:

- it is the largest remaining product gap
- later approval and automation logic should run on the effective workflow, not only the workspace workflow

### Phase 9. Approval and Review Gates

Status: Not started

Needs to be implemented:

- required reviewer count
- reviewer role restriction
- reviewer source
  - project members
  - team lead
  - department head
  - manual reviewer
- review completion rule before entering final states

Benefit:

- review becomes a true governance stage
- useful for QA, design review, security review, and release review
- prevents fake review completion

### Phase 10. Advanced Automation Coverage

Status: Not started

Needs to be implemented:

- when all subtasks complete -> suggest move to done
- stronger stale-state reminders
- at-risk automation depth
- richer PR-based workflow automation beyond current basics
- optional cycle-start promotion policies by scope

Benefit:

- less manual status maintenance
- better workflow freshness
- stronger operational discipline without noisy admin effort

### Phase 11. Workflow Templates and Presets

Status: Not started

Needs to be implemented:

- reusable workflow presets
- team or department starter templates
- preset cloning from workspace/project defaults

Benefit:

- much faster onboarding
- easier enterprise rollout across many teams
- reduces admin setup inconsistency

### Phase 12. Export / Merge / Migration Tooling

Status: Not started

Needs to be implemented:

- export affected issues before migration
- bulk merge one status into another
- safer archive/replace flows
- audit-friendly workflow migration summaries

Benefit:

- safer workflow evolution
- cleaner admin operations
- better support for large customer workspaces

## Explicitly Removed / No Longer Planned

### Default Status by Issue Type

Status: Removed from current plan

Reason:

- it couples issue type too tightly to workflow defaults
- it adds complexity early without enough product value
- current product direction prefers workflow scope control before type-specific defaulting

Do not implement this unless product requirements change later.

## What Should Be Done Next

### Next Implementation Priority

#### 1. Project-Level Workflow Override

Do next:

- add project workflow override storage
- add project workflow settings UI
- build a single effective-workflow resolver
- use that resolver in:
  - issue create
  - issue update
  - status movement
  - board rendering
  - list grouping
  - cycle views
  - automation runtime

Why next:

- biggest remaining workflow capability gap
- unlocks realistic multi-project usage
- prevents later approval/automation work from being built on the wrong scope model

#### 2. Approval and Review Gates

Do after project override:

- reviewer count
- reviewer source
- approval gate before done or release states

Why after:

- approval rules should attach to the effective workflow, not only the workspace workflow

#### 3. Advanced Automation

Do after approval gates:

- automation should know whether a state is blocked by approval
- avoids building automation twice

#### 4. Migration / Merge / Export

Do after overrides and advanced rules:

- by then admins will need safer migration tools more urgently

#### 5. Templates / Presets

Do after the workflow model stabilizes:

- templates should sit on top of the final workflow shape

## What Not To Do Yet

- do not add team override before project override
- do not add issue-type-specific workflow defaults back into the product
- do not build templates before the scope model stabilizes
- do not build migration/export tooling before the final override structure is known
- do not add review gates without first deciding how effective workflow resolution works

## Engineering Checklist

Before marking workflow configuration complete, confirm:

- every issue flow resolves the correct workflow scope
- every automation uses the same workflow resolver
- every blocked status move returns a clear user-facing reason
- workflow changes are logged in activity/audit surfaces
- inactive or retired statuses do not break old issues
- cycle calculations use the effective workflow meaning
- frontend and backend validations match
- migrations are safe for existing workspaces

## Definition of Done

Workflow configuration should be considered complete only when:

- workspace workflow is configurable
- project override exists
- team override exists if still needed
- review/approval gates exist
- advanced automation exists
- migration tooling exists
- templates/presets exist if still valuable after rollout
- all issue, cycle, board, and automation flows consistently use the effective workflow
