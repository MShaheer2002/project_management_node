# Linearis — Future Scope Build Phases

## Purpose

This document holds **deferred**, **exploratory**, and **later-phase** roadmap items that are intentionally kept out of the active backend build plan.

Use it to track:
- Features that are valuable but not currently committed
- Large workflow expansions that need separate product shaping
- Platform extensions that should not block the core roadmap
- Ideas such as epics, imports, AI layers, and other future systems

The active delivery roadmap remains in [build-phases.md](./build-phases.md).

## How To Use This Doc

- Keep active/committed work in `build-phases.md`
- Add future items here using stable IDs like `FS-1`, `FS-2`, `FS-3`
- Group future work by theme so new items can be added without renumbering the core roadmap
- Promote an item into the active roadmap only when scope, dependency, and done criteria are clear

## Suggested Structure For New Items

Each future phase should ideally include:
- `Goal`
- `Why later`
- `Dependencies`
- `Candidate scope`
- `Out of scope`
- `Promotion trigger`

## Future Scope Index

| ID | Theme | Status | Summary |
|---|---|---|---|
| `FS-1` | Platform Migration | Deferred | One-time import from external platforms like Linear, Jira, ClickUp, Asana, and Trello |
| `FS-2` | Workflow Expansion | Placeholder | Epics and other higher-level planning containers |

---

## FS-1 — Data Import & Migration

**Goal:** Allow teams to move into Linearis from other platforms without recreating their workspace manually.

**Why later:**
- Useful for adoption, but not required to complete the current integrations roadmap
- Large migration work adds product and data-mapping complexity
- Better handled after the core collaboration model is stable

**Dependencies:**
- Stable issues, comments, labels, projects, cycles, and members model
- Reliable background job/progress architecture if imports are long-running
- Clear workspace-level permissions for import and rollback handling

**Candidate scope:**
- Source selection for:
  - Linear
  - Jira
  - ClickUp
  - Asana
  - Trello
- Read-only source authentication
- Import preview with counts
- Status, priority, team, and member mapping
- Background import progress
- Import summary with warnings/skips
- Import history for audit
- Duplicate detection on re-import

**Out of scope for first version:**
- Continuous sync back to the source platform
- Full attachment migration if storage and retry flow are not ready
- Source-specific custom workflows beyond normalized Linearis mapping

**Promotion trigger:**
- Import becomes necessary for go-to-market, customer migration, or workspace onboarding

---

## FS-2 — Epics & Higher-Level Planning

**Goal:** Add a planning layer above individual issues so teams can group multiple tasks under a larger delivery unit.

**Why later:**
- Requires clear relationship rules with projects, milestones, cycles, and roadmaps
- Can become messy if added before the team agrees on the planning model

**Dependencies:**
- Stable issue, roadmap, and project hierarchy rules
- Clear reporting expectations for progress rollups

**Candidate scope:**
- Epic entity with title, description, status, owner, and target dates
- Link many issues to one epic
- Progress rollups across child issues
- Epic views on roadmap/project screens
- Filters by epic across issue lists and analytics

**Out of scope for first version:**
- Nested epics
- Arbitrary multi-level hierarchy
- Cross-workspace epics

**Promotion trigger:**
- Teams need a planning unit above issues and below long-term roadmap strategy

---

## Notes

- Keep this document additive. New future scope items should be appended, not mixed into the active phase plan until committed.
- If a future item becomes real delivery work, move it into [build-phases.md](./build-phases.md) with a proper phase slot and done criteria.
