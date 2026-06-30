# Phase 20F - Trussen AI Coverage, Clarification, and Analytics Expansion Plan

> Purpose: define how Trussen AI should evolve from a mostly issue-centric assistant into a role-aware workspace operator that can safely handle broad CRUD workflows, invitations, membership changes, planning flows, and analytics/reporting prompts across the product.

---

## 0. Phase Completion Snapshot

### 0.1 Status

Phase 20F is now effectively complete for implementation and hardening.

- `20f.1` implemented
- `20f.2` implemented
- `20f.3` implemented
- `20f.4` implemented
- `20f.5` implemented
- `20f.6` started with deterministic scenario coverage and hardening

The remaining work is now mostly:

- broader automated scenario coverage expansion
- manual QA execution
- product polish iterations

### 0.2 Before vs After

Before phase 20F:

- Trussen AI was strongest only at issue-centric flows
- analytics support was generic and under-scoped
- clarification behavior depended too much on model phrasing
- background AI and side-panel AI were not operating from the same expanded capability surface
- mutation dedupe, confirmation safety, and auditability were partial

After phase 20F:

- Trussen AI covers the major non-destructive CRUD and operational flows across issues, teams, departments, cycles, workspace membership, templates, documents, roadmap, analytics, notifications, multi-workspace visibility, and API key creation
- analytics are scope-aware with explicit tools for workspace, project, team, member, and cycle reporting plus exports
- clarification and pending-action handling are deterministic for invites, issue creation, document creation, analytics, high-impact actions, delete boundaries, and follow-up turns
- background AI now expands alongside Trussen AI with anchored, expiring, superseding suggestions and shared analytics/reporting primitives
- high-impact actions require explicit confirmation and are server-side bound to the exact approved tool call
- mutation replay, duplicate protection, and AI activity audit trails are materially stronger than the pre-20F implementation

### 0.3 What Was Implemented In 20F

`20f.1` reliability foundation:

- deterministic `PendingAction` state
- clarification vs confirmation split
- delete-boundary state machine
- cross-turn slot filling for key workflows
- mutation idempotency/replay foundation

`20f.2` CRUD and non-destructive expansion:

- issue status, subtasks, watchers, dependencies, integration refs
- team CRUD and membership management
- department CRUD and membership management
- cycle CRUD, complete/reopen/carry-over
- workspace member and status operations
- project membership operations
- template CRUD and lifecycle operations
- document and folder operations
- roadmap schedule, milestone, and dependency operations
- notifications
- multi-workspace listing and invite acceptance
- API key listing/get and integration status reads
- workspace access summary
- API key creation with secret-safe replay behavior

`20f.3` analytics expansion:

- explicit scoped analytics tools
- export workflow
- period-aware and comparison-aware parsing
- analytics provenance metadata in tool responses
- report formatting reused by chat and background systems

`20f.4` background AI expansion:

- project health summaries
- team health summaries
- cycle health summaries
- shared analytics/reporting primitives
- suggestion anchoring, superseding, and expiry lifecycle

`20f.5` auditability and execution safety:

- AI actor metadata on mutations
- persisted confirmation state
- exact confirmed tool binding on the backend
- partial-failure handling guidance
- stronger replay protection for create/update flows
- secret-safe idempotency persistence for API key creation

### 0.4 Intentional Exclusions After 20F

These are intentionally not exposed through Trussen AI even after 20F:

- all delete operations
- API key revoke
- API key rotate if implemented as revoke + recreate
- integration disconnect through AI

These remain excluded because the product policy is:

```text
AI is never allowed to delete anything.
```

These are also not implemented yet because the backend does not currently provide safe underlying primitives for them:

- `trigger_integration_sync`
- `get_import_run_status`

If those are needed later, they should be implemented as new audited backend capabilities first, then exposed to AI in a separate phase.

---

## 1. Why This Phase Exists

The current Trussen AI panel is useful, but its real capability surface is narrower than the product surface.

Today it is strongest at:

- Issue creation and updates
- Basic project queries
- Basic team/member queries
- Invitations
- Limited cycle reads
- Limited analytics reads

It is **not yet a complete AI operator for the app**.

This creates three product problems:

1. Users assume the panel can do everything visible in the app, but the tool layer cannot yet support that expectation.
2. Missing-input handling is still too dependent on model behavior instead of deterministic workflow logic.
3. Analytics prompts are broader than the current `get_analytics` abstraction and need first-class scope-aware tools and response shaping.

This document covers both:

1. A full coverage matrix for AI-addressable CRUD and operational flows across the app.
2. A deterministic clarification / slot-filling design so edge cases are handled reliably instead of hoping the model asks the right follow-up.

It also defines a dedicated analytics/reporting expansion because analytics is a major user intent for Trussen AI.

---

## 2. Current State Summary

This section records the original baseline that phase 20F started from. The completion snapshot above reflects the current implemented state.

### 2.1 What the AI tool layer supports today

Current Trussen AI tools in `modules/ai/tools/tool-definitions.ts`:

- `list_issues`
- `get_issue`
- `create_issue`
- `update_issue`
- `assign_issue`
- `add_comment`
- `add_label_to_issue`
- `list_projects`
- `get_project_summary`
- `create_project`
- `update_project`
- `list_teams`
- `list_team_members`
- `list_members`
- `get_team_workload`
- `invite_member`
- `list_cycles`
- `get_cycle_progress`
- `list_labels`
- `get_analytics`
- `search_issues`

### 2.2 What that means in practice

Implemented well enough today:

- Create/update/query issues
- Assign issues
- Add comments and labels
- Create/update projects
- List teams and members
- Invite a member when email, role, and team are provided
- Read some cycle data
- Read some analytics data

Not implemented as AI actions today:

- Create team
- Update team
- Delete team
- Add/remove team members
- Create department
- Update department
- Add/remove department members
- Create cycle
- Update cycle
- Complete / reopen / carry-over cycle
- Create / update / delete templates
- Activate / deactivate templates
- Workspace create / update / status management
- Change member roles
- Remove workspace members
- Roadmap milestone and dependency management
- Document and folder operations
- Issue subtasks / watchers / dependencies / attachments
- Notification operations
- Analytics exports
- Multi-workspace switching and invite acceptance flows
- API key management
- Integration status, connect flows, and sync/reporting actions

### 2.3 Important conclusion

The current implementation does **not** cover “almost all CRUD in the app.”

It covers a meaningful subset, but the gap between product expectation and actual tool support is still large.

---

## 3. Role and Permission Rules the AI Must Respect

The AI must never invent its own permission logic. It must always defer to existing backend services and route/business rules.

### 3.1 Workspace roles

From schema:

- `OWNER`
- `ADMIN`
- `MEMBER`
- `GUEST`

General policy:

- `GUEST`: read-only or very limited collaboration
- `MEMBER`: issue/cycle/comment collaboration, some create/update operations
- `ADMIN`: management actions across most workspace scopes
- `OWNER`: highest human authority in the workspace

### 3.2 Current route-level examples that matter for AI design

Issues:

- Create/update/status/subtasks/watchers/dependencies/attachments: `MEMBER+`
- Delete issue: `ADMIN/OWNER`

Projects:

- Create project: current route allows `MEMBER+`
- Update project: ownership-based
- Delete project: ownership-based
- Manage project members: ownership-based

Teams:

- Create team: current route allows `MEMBER+`
- Update team: ownership-based
- Delete team: `ADMIN/OWNER`
- Manage team members: ownership-based

Departments:

- Create/delete department: `ADMIN/OWNER`
- Update/manage members: ownership-based

Cycles:

- Create/update/complete/carry-over/delete: `MEMBER+`
- Reopen cycle: `ADMIN/OWNER`

Workspace:

- Update workspace: `ADMIN/OWNER`
- Delete workspace: `OWNER`
- Invite / role changes / member removal: `ADMIN/OWNER`
- Update custom statuses: `ADMIN/OWNER`

Templates:

- Create/update/delete/activate/deactivate: `ADMIN/OWNER`

Documents:

- Read many document surfaces: `MEMBER+`
- Workspace document/folder mutations: `ADMIN/OWNER`
- Team/project document mutations depend on the document module’s route rules and scope ownership expectations

Analytics:

- Workspace analytics: `ADMIN/OWNER`
- Project/team/member/cycle analytics: `MEMBER+`, then narrowed by scope access checks

### 3.3 Global AI safety rule: no delete operations

This must be a hard product rule across all AI surfaces:

- Trussen AI side panel
- AI issue creator
- Background AI
- future external agent surfaces unless the product policy explicitly separates them

Rule:

```text
AI is never allowed to delete anything.
```

That includes:

- issues
- subtasks
- comments
- attachments
- documents
- folders
- projects
- teams
- departments
- cycles
- templates
- roadmap milestones
- workspace members
- workspaces
- notifications
- any other mutable entity

Even if the human UI allows deletion for a privileged role, AI must remain unauthorized to perform deletes.

Preferred AI behavior:

- explain that deletion is not available through Trussen AI
- suggest non-destructive alternatives like archive, complete, deactivate, unassign, remove access, or manual admin action where appropriate

### 3.4 AI permission design rules

The AI must follow these rules on every action:

1. Never expose a tool unless its action is actually supported and permission-checked.
2. Never “simulate success” for a forbidden action.
3. When permission is insufficient, explain the boundary plainly.
4. For ownership-based domains, AI must call the existing service/tool and let it enforce the rule.
5. AI must never call delete operations, even with confirmation.

---

## 4. Coverage Matrix: App Surface vs Current AI Coverage vs Target AI Coverage

This is the core gap matrix.

### 4.1 Issues

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| Issues | create, update, assign, comment, label, search, summarize | Mostly yes | Full |
| Issue status | move issue, start work, mark done, ready for review | Partial via `update_issue` | Full with dedicated phrasing support |
| Subtasks | create, update, reorder | No | Full |
| Watchers | add/list watchers | No | Full non-destructive support |
| Dependencies | add/list dependencies | No | Full non-destructive support |
| Attachments | attach/list issue files | No | Full non-destructive support |
| Integration refs | link/update external refs | No | Full non-destructive support |
| Delete issue | No AI delete | Permanently unsupported by AI |

### 4.2 Projects

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| Projects | list, summary, create, update | Partial | Full |
| Project membership | add/remove project members | No | Full |
| Project lead changes | not explicit today | No | Full |
| Project status lifecycle | archive, complete, reactivate | Partial | Full |
| Project analytics | broad only | Partial | Full with dedicated tool |
| Project roadmap | milestone/dependency/schedule ops | No | Full |

### 4.3 Teams

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| Teams | list, members, workload | Partial read | Full |
| Team create/update | No | Full |
| Team member add/remove | No | Full |
| Team docs and team reporting | No | Full |
| Team analytics | indirect only | Full |

### 4.4 Departments

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| Departments | create, list, update | No | Full |
| Department members | add/remove/list | No | Full |
| Department analytics | No | Full |

### 4.5 Workspace administration

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| Workspace details | limited | No | Full read/update where allowed |
| Member invites | Partial | Full |
| Change member role | No | Full |
| Remove member | No | Full |
| Custom statuses | No | Full |
| Workspace analytics | No dedicated AI tool | Full |

### 4.6 Cycles / sprint planning

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| Cycle list/progress | Yes | Full read |
| Create cycle | No | Full |
| Update cycle | No | Full |
| Complete/reopen/carry-over | No | Full |
| Cycle analytics/reporting | Partial generic | Full |
| Sprint planning | background AI only | Full conversational surface |

### 4.7 Templates

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| List/get templates | No | Full |
| Create/update template | No | Full |
| Duplicate/activate/deactivate | No | Full |

### 4.8 Documents

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| List workspace/team/project docs | No | Full |
| Create folder | No | Full |
| Rename/move folder | No | Full |
| Create/update document metadata | No | Full |
| Move document | No | Full |

### 4.9 Roadmap

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| Roadmap list | No | Full |
| Project roadmap detail | No | Full |
| Update schedule | No | Full |
| Create/reorder/update milestones | No | Full |
| Create/resolve/cancel dependencies | No | Full |

### 4.10 Comments, notifications, and collaboration

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| Issue comments | Partial | Full |
| Comment edit | No | Full where allowed |
| Notification reads | No | Full |
| “Summarize my unread updates” | No | Full |
| “What changed in my teams today?” | No | Full |

### 4.11 Multi-workspace and identity context

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| Workspace switching | switch workspace, confirm current workspace, compare accessible workspaces | No | Full |
| Cross-workspace invites | list pending invites, accept invite, explain access state | No | Full |
| Cross-workspace navigation help | “open Ridely workspace”, “which workspace has this project?” | No | Full |

### 4.12 API keys and integrations

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| API keys | list, create, rotate, revoke | No | Full |
| Integration status | list connected tools, show health/sync status | No | Full |
| Integration setup guidance | connect Slack/GitHub/Discord/Figma, explain missing prerequisites | No | Full |
| Integration reporting | summarize import/sync status, mapping gaps, delivery failures | No | Full |

### 4.13 AI execution safety and operational governance

| Domain | User intents | Current AI support | Target support |
|---|---|---|---|
| High-impact mutations | role change, member removal, archive/complete actions | Prompt-dependent | Explicit preview/confirm rules |
| Duplicate protection | retry chat message, reconnect SSE, repeated mutation prompts | Partial at best | Full idempotency and dedupe |
| Auditability | explain who changed what and why | Partial activity only | Full AI action traceability |
| Partial failure handling | multi-step requests that fail halfway | No | Full plan/rollback-aware behavior |

---

## 5. Target Tool Expansion

The AI should not be expected to cover the app until the tool layer explicitly covers the app.

### 5.1 New tool families required

Issue operations:

- `update_issue_status`
- `create_subtask`
- `update_subtask`
- `reorder_subtasks`
- `add_issue_watchers`
- `list_issue_watchers`
- `add_issue_dependency`
- dependency removal remains unsupported by AI unless implemented as a non-destructive state transition
- `add_issue_attachment`
- attachment removal remains unsupported by AI unless implemented as a non-destructive state transition

Team operations:

- `get_team`
- `create_team`
- `update_team`
- `add_team_members`
- `remove_team_member`

Department operations:

- `list_departments`
- `get_department`
- `create_department`
- `update_department`
- `add_department_members`
- `remove_department_member`

Workspace operations:

- `get_workspace`
- `update_workspace`
- `list_workspace_members`
- `change_workspace_member_role`
- `remove_workspace_member`
- `update_workspace_statuses`

Project operations:

- `list_project_members`
- `add_project_members`
- `remove_project_member`
- `archive_project`
- `complete_project`

Cycle operations:

- `get_cycle`
- `create_cycle`
- `update_cycle`
- `complete_cycle`
- `reopen_cycle`
- `carry_over_cycle`

Template operations:

- `list_templates`
- `get_template`
- `create_template`
- `update_template`
- `duplicate_template`
- `activate_template`
- `deactivate_template`

Documents:

- `list_documents`
- `list_document_folders`
- `create_document_folder`
- `rename_document_folder`
- `move_document_folder`
- `move_document`
- `update_document`

Roadmap:

- `list_roadmap`
- `get_project_roadmap`
- `update_project_schedule`
- `create_milestone`
- `update_milestone`
- `reorder_milestones`
- `create_roadmap_dependency`
- `resolve_roadmap_dependency`
- `cancel_roadmap_dependency`

Notifications and collaboration:

- `list_notifications`
- `mark_notification_read`
- `mark_all_notifications_read`

Multi-workspace:

- `list_user_workspaces`
- `get_workspace_access_summary`
- `list_pending_workspace_invites`
- `accept_workspace_invite`

API keys and integrations:

- `list_api_keys`
- `create_api_key`
- `rotate_api_key`
- `revoke_api_key`
- `list_integrations`
- `get_integration_status`
- `trigger_integration_sync`
- `get_import_run_status`

### 5.2 Tool design requirements

Every new tool must:

1. Be workspace-scoped.
2. Reuse existing services/controllers where possible.
3. Return compact, structured data.
4. Enforce permissions in executor/service code, not only in prompt text.
5. Produce user-facing summaries without leaking implementation details.
6. Exclude delete semantics entirely from the AI tool surface.
7. Support idempotency keys for every mutating action.
8. Emit auditable actor metadata such as "Trussen AI on behalf of <user>".

### 5.3 Execution safety requirements for mutating actions

Not every non-delete action should execute immediately.

Require explicit preview + confirmation for:

- changing a workspace role
- removing a workspace member
- removing a project/team/department member
- archiving or completing a project
- completing, reopening, or carrying over a cycle
- any multi-entity batch action

Preferred behavior:

1. AI summarizes the intended mutation.
2. AI shows the specific target entities.
3. AI asks for a short confirmation such as `Confirm`.
4. Only then is the tool executed.

### 5.4 Non-destructive alternatives the AI should prefer

Instead of delete actions, AI should map user intent to safer alternatives where available:

- delete issue -> archive/close/mark done/explain manual deletion only
- delete project -> archive project
- delete team -> explain manual admin action only
- delete cycle -> complete or reopen depending on intent
- delete template -> deactivate template
- delete document -> explain manual deletion only unless a soft-remove/archive state exists later
- remove content from active workflow -> unassign, move, deactivate, archive, or cancel

---

## 6. Deterministic Clarification and Slot-Filling Layer

This is the most important reliability gap.

Today the model is told to ask one clarifying question if unclear. That is useful but not sufficient for broad CRUD coverage.

### 6.1 Problem

Prompts like these are common:

- “Invite Ahmed to backend.”
- “Create a project for the mobile team.”
- “Move Ridely forward.”
- “Add Sara to the design team.”
- “Create a cycle for next week.”
- “Give me Ali’s last 5 day report.”

These are not invalid prompts. They are **incomplete operational intents**.

If the AI only relies on raw model reasoning, the system will be inconsistent across prompts, roles, and entities.

### 6.2 Required architecture

Add a deterministic pre-tool resolution layer with these phases:

1. Intent classification
2. Action schema lookup
3. Required slot detection
4. Context resolution
5. Ambiguity detection
6. Clarification generation
7. Tool execution

### 6.3 Intent schema examples

Every action must define:

- `intent`
- `requiredSlots`
- `optionalSlots`
- `defaults`
- `permissionPredicate`
- `resolutionStrategy`
- `clarificationPrompts`

Example: `invite_member`

Required:

- `email`
- `role`
- `teamId`

Optional:

- `departmentId`
- `note`

Clarification priority:

1. Missing email
2. Missing role
3. Missing team

If user says:

`Invite someone to backend`

The AI must not improvise.

It should ask:

`Who should I invite? Please send the email address.`

If user then says:

`ahmed@gmail.com`

The system should preserve the pending action state and ask only the next unresolved question:

`What role should I give Ahmed: admin, member, or guest?`

### 6.4 Clarification state machine

Need a `PendingAction` layer in conversation state:

```ts
type PendingAction = {
  action: "invite_member" | "create_project" | "create_team" | "create_cycle" | ...;
  slots: Record<string, unknown>;
  missing: string[];
  ambiguity?: {
    field: string;
    candidates: Array<{ id: string; label: string }>;
  }[];
  createdAt: string;
};
```

This lets AI continue reliably across turns instead of re-parsing from scratch every time.

### 6.5 Ambiguity handling

Common ambiguity classes:

- Multiple projects with similar names
- Multiple members with similar names
- Team names vs department names
- “Next sprint” when multiple teams have current planning cycles
- “Move Ridely forward” meaning status vs timeline vs cycle vs roadmap

Required behavior:

- Ask one narrowed follow-up
- Present top valid options
- Preserve already-known slots

Example:

`Invite Ahmed as member`

If multiple teams could match:

`Which team should Ahmed join? I found Backend Team and Backend Platform.`

### 6.6 Validation-first rules

Before any tool call:

- Validate required slots exist
- Validate email shape if relevant
- Validate date ranges if relevant
- Validate referenced names resolve to exactly one visible entity
- Validate user has permission to perform the action

If validation fails:

- ask clarification if recoverable
- return permission or domain error if not recoverable

### 6.7 Edge cases this layer must explicitly cover

Invites:

- user says invite with no email
- email invalid
- email already a workspace member
- pending invite already exists
- missing role
- invalid role
- missing target team
- private team not visible

Projects:

- missing team owner
- ambiguous team
- duplicate project name
- member lacks create permission
- request includes initial docs but user is not admin/owner

Teams:

- missing department or lead if required by schema
- adding someone already in team
- removing sole lead
- private team visibility conflicts

Cycles:

- missing team
- missing dates
- invalid date range
- overlapping or conflicting cycle windows
- reopen not permitted for role

Analytics:

- no scope provided
- multiple matching scopes
- user asks for workspace analytics without admin/owner role
- reporting range missing or vague
- member asks for another employee’s analytics without permission

### 6.8 Implementation recommendation

Do not push this entirely into the LLM prompt.

Instead:

1. Add intent schemas in code.
2. Run a deterministic slot validator before tool selection.
3. Store a `PendingAction` in conversation state.
4. Let the model phrase the clarification, but only after code decides which field is missing.
5. Distinguish between `clarification required` and `confirmation required` so risky actions do not bypass review.

That gives predictable behavior across hundreds of edge cases.

### 6.9 File and attachment handoff

Some actions require binary data, not just text intent.

Examples:

- upload a project doc
- attach a file to an issue
- import a CSV during integration setup

The AI should not pretend a file upload happened from plain chat text.

Required behavior:

1. If the needed file is missing, ask for the file explicitly.
2. If the panel supports file pickers, hand off to the existing upload flow.
3. If the file already exists in app storage, resolve and reuse it by ID.
4. Never invent attachment success without an actual upload artifact.

---

## 7. Analytics and Reporting: Current Coverage vs Needed Coverage

Analytics is a major Trussen AI use case and deserves its own explicit design.

### 7.1 Current backend analytics coverage

Existing analytics routes already support:

- workspace analytics
- project analytics
- team analytics
- member analytics
- cycle analytics
- export analytics

This means the raw backend data foundation is already ahead of the AI tool layer.

### 7.2 Current AI analytics gap

The AI currently has only one broad analytics tool:

- `get_analytics`

That is too generic for real user requests like:

- “Tell me the progress of Ridely App according to the cycle plan and current implementation.”
- “Show me the last 5 days performance report for Ali.”
- “Who is overloaded in Backend this week?”
- “Compare the last 3 cycles for the mobile team.”
- “What is the bug completion trend for Ridely App this month?”
- “Give me blockers, bottlenecks, and overdue work for the design team.”

### 7.3 Analytics intents Trussen AI must support

#### Workspace analytics

Prompts:

- “How is the workspace doing this month?”
- “What are the top blockers right now?”
- “How many urgent issues are still open?”
- “Show completion trend for the last 30 days.”

Requires:

- workspace-wide totals
- priority/status/type breakdowns
- overdue and bottleneck views
- trend summaries

Permission:

- `ADMIN/OWNER`

#### Project analytics

Prompts:

- “How is Ridely App progressing?”
- “Is Ridely App on track?”
- “What is the completion rate for Ridely App?”
- “Show me scope growth in Ridely App over the last 2 weeks.”

Requires:

- project completion
- status breakdown
- priority breakdown
- scope change count
- burn-up / burndown-like trend
- projected timeline health
- project member workload

Permission:

- `MEMBER+` plus project visibility/ownership checks

#### Team analytics

Prompts:

- “How is Backend team doing this sprint?”
- “Who is overloaded in the mobile team?”
- “Compare the last 6 cycles for Backend.”
- “What is the team velocity trend?”

Requires:

- member workload
- completed issues in range
- cycle comparison
- completion velocity
- overdue and stuck work
- average resolution time

Permission:

- `MEMBER+` plus team visibility checks

#### Member analytics

Prompts:

- “Give me a 5 day report for Ali.”
- “What did Sarah finish in the last week?”
- “How many issues did Ahmed complete?”
- “Is Zain overloaded?”

Requires:

- assigned/completed/in-progress/overdue counts
- completion rate
- issue activity in date range
- by-project breakdown
- by-team breakdown
- recent activity feed
- optionally narrative summary

Permission:

- `MEMBER+` but must respect member analytics access rules

#### Cycle analytics

Prompts:

- “How is cycle 12 going?”
- “Will this sprint finish on time?”
- “What is left in the current sprint?”
- “Show velocity for current cycle.”

Requires:

- total/completed/remaining
- scope by status / priority / type
- daily velocity
- burndown trend
- overdue and blocked items

Permission:

- `MEMBER+` plus cycle/team visibility checks

### 7.4 New analytics tools required

Replace the single generic analytics tool with explicit scoped tools:

- `get_workspace_analytics`
- `get_project_analytics`
- `get_team_analytics`
- `get_member_analytics`
- `get_cycle_analytics`
- `export_analytics`
- `get_current_cycle_for_team`
- `get_project_roadmap_health`
- `get_team_capacity_report`
- `get_member_activity_report`

### 7.5 Why explicit analytics tools are better

Benefits:

1. Better permission control per scope.
2. Cleaner prompt-to-tool routing.
3. Better output formatting for each entity type.
4. Easier testing.
5. Less chance of the model inventing scope assumptions.

### 7.6 Example: Ridely App progress according to cycle plan and current implementation

This user intent is not a single simple query.

It likely needs:

1. Resolve project `Ridely App`
2. Get project analytics
3. Get team or cycle analytics for the project’s owning team
4. Optionally get roadmap detail / milestones if “plan” means roadmap commitments
5. Summarize:
   - completed vs total
   - current sprint contribution
   - overdue/high-risk items
   - timeline health
   - blockers and next actions

This should become a composed AI workflow, not one generic `get_analytics` call.

### 7.7 Example: employee report for the last 5-6 days

User prompt:

`Give me Ali’s last 5 day report.`

Expected AI flow:

1. Resolve `Ali` to member ID
2. Use `get_member_analytics(memberId, days=5)`
3. Optionally combine recent activity feed
4. Return:
   - issues completed
   - issues in progress
   - overdue items
   - by-project contribution
   - recent comments / status changes
   - concise narrative summary

### 7.8 Reporting UX expectations

Analytics responses should support two modes:

1. Fast answer mode
2. Detailed report mode

Fast answer mode:

- 3-5 bullets
- top metrics
- one sentence conclusion

Detailed report mode:

- summary
- key metrics
- risks / blockers
- contributor breakdown
- optional export link or generated file

### 7.9 Natural-language analytics patterns to support

The AI should understand:

- relative periods: `today`, `this week`, `last 5 days`, `last sprint`
- comparative periods: `vs previous sprint`, `compared to last month`
- scope references: workspace, team, member, project, cycle
- output style: `summary`, `report`, `bullet points`, `export`

### 7.10 Analytics trust and traceability requirements

Analytics answers should include:

- the resolved scope
- the resolved date range
- the "as of" timestamp for the data
- metric-definition clarity where wording could be ambiguous
- a short note when the result is inferred from multiple tools or partial data

This is especially important for prompts about employee performance, project health, and cycle risk.

---

## 8. Background AI Expansion Must Track Trussen AI Expansion

Background AI and Trussen AI should not evolve as separate products.

They are two surfaces over the same operational intelligence layer:

- Trussen AI: user-triggered conversational operator
- Background AI: event-driven passive intelligence and suggestions

As Trussen AI gains more capabilities, Background AI should expand in parallel so both systems reinforce each other.

### 8.1 Principle

Every new domain added to Trussen AI should be evaluated for a matching background AI opportunity.

Examples:

- project operations -> project health drift, scope creep, stalled project warnings
- team operations -> overload warnings, understaffed team alerts, team imbalance suggestions
- cycle operations -> sprint risk, carry-over prediction, missed commitment detection
- invites and membership -> onboarding nudges, role mismatch warnings, unassigned member suggestions
- roadmap -> milestone slip warnings, dependency risk alerts
- documents -> stale docs, missing briefs, outdated team agreements
- templates -> unused templates, duplicate templates, missing active defaults

### 8.2 Shared intelligence primitives

Both Trussen AI and Background AI should share:

- scope resolution
- permission logic
- analytics summaries
- embeddings and semantic search
- recommendation logic
- activity interpretation
- confidence scoring

This avoids one system being smarter than the other in inconsistent ways.

### 8.3 Background AI expansion areas

Near-term additions:

- project progress risk suggestions
- cycle slippage warnings
- member overload and capacity balancing suggestions
- roadmap dependency risk suggestions
- template adoption suggestions
- document freshness suggestions

Later additions:

- weekly stakeholder digests by project/team/member
- proactive manager briefings
- sprint readiness scoring
- trend anomaly detection

### 8.4 Safety rule for Background AI

Background AI must remain non-destructive as well.

It may:

- observe
- analyze
- suggest
- notify
- summarize

It must not:

- delete
- silently mutate
- silently reassign ownership
- silently remove access

### 8.5 Product expectation

Users should experience one coherent system:

- Trussen AI can answer, create, update, summarize, and act safely
- Background AI can proactively surface what Trussen AI would likely recommend

The two should work together, not diverge.

### 8.6 Suggestion lifecycle and conversation anchoring

Background suggestions shown inside the Trussen AI panel should:

- stay attached to the assistant response or entity context that produced them
- supersede older suggestions when a fresher suggestion for the same target exists
- expire when the underlying state materially changes
- avoid floating to unrelated later messages in the same conversation

This matters because suggestion trust drops quickly when placement looks detached from the action that caused it.

---

## 9. Recommended Product Behavior for AI Replies

### 9.1 For CRUD operations

When successful:

- confirm exactly what changed
- show entity name/ID
- do not expose tool names
- do not expose provider/model names

Example:

`Created project "Ridely App Payments" under Backend Team.`

Not:

`Used create_project`

### 9.2 For missing input

Ask one precise follow-up:

- not a paragraph
- not multiple questions at once
- not vague

Good:

`Who should I invite? Please send the email address.`

Bad:

`Sure, I can help with that. Can you tell me who, what role, what team, and whether you want them to be admin?`

### 9.3 For analytics

The AI should state:

- scope
- date range
- confidence / limitations if data is partial
- next action suggestion when useful

Example:

`Ridely App completed 18 of 27 issues this cycle (67%). Two urgent issues remain open and one is overdue. At the current completion pace, the project looks slightly behind its target date.`

### 9.4 For multi-step and high-impact actions

For actions that touch multiple entities or materially change access/planning state, the AI should behave like an operator, not an autocomplete layer.

It should:

- present a short execution plan first
- show what will change
- call out any missing approvals or blockers
- confirm final outcome step-by-step if partial completion occurs

---

## 10. Implementation Plan

### Phase 20F.1 - Reliability foundation

- Add deterministic intent schemas
- Add pending action state
- Add slot validator
- Add ambiguity resolver
- Add explicit clarification response format
- Add confirmation-required action classification
- Add idempotency keys for AI mutations

### Phase 20F.2 - CRUD and non-destructive operation expansion

Add tools in this order:

1. team create/update/member ops
2. cycle create/update/complete ops
3. workspace member and role ops
4. project member ops
5. department ops
6. template ops
7. roadmap ops
8. document ops
9. comment/watcher/subtask/dependency/attachment ops
10. multi-workspace and invite acceptance ops
11. API key and integration status ops

Important constraint:

- this phase expands create/read/update and safe operational flows
- delete flows remain excluded from AI permanently

### Phase 20F.3 - Analytics expansion

- Replace generic `get_analytics`
- Add scoped analytics tools
- Add report response formatter
- Add export workflow
- Add comparative and period-aware prompt parsing
- Add analytics provenance metadata (`scope`, `range`, `asOf`, partial-data note)

### Phase 20F.4 - Background AI expansion

- add background suggestions for new supported domains
- share analytics primitives between chat AI and background AI
- add domain-specific proactive summaries
- keep background AI suggestion-only and non-destructive
- add suggestion lifecycle rules for anchoring, superseding, and expiry

### Phase 20F.5 - Auditability and execution safety

- record AI actor metadata on every mutation
- store preview/confirmation state for high-impact actions
- add partial-failure handling for multi-step plans
- ensure retries do not duplicate creates/invites/role changes

### Phase 20F.6 - Testing and hardening

Need scenario tests for:

- missing fields
- ambiguous entity names
- permission denial
- private scope visibility
- existing duplicates
- invalid emails
- invalid date ranges
- cross-turn pending actions
- analytics access boundaries
- report prompts with partial scope
- user asking AI to delete something
- background AI suggesting unsafe destructive actions
- repeated submission of the same prompt causing duplicate mutations
- confirmation-required actions attempted without confirmation
- file-upload intents without an attached file
- cross-workspace prompts with the wrong active workspace
- API key secret handling and non-replay behavior

---

## 11. Acceptance Criteria

Trussen AI should be considered ready for broad “do things in the app” use only when:

- every major app domain has explicit tool coverage or is intentionally excluded
- delete operations are intentionally excluded from all AI surfaces
- missing-input flows are code-driven, not prompt-only
- permissions are enforced per action
- project/team/private visibility is preserved
- analytics prompts map to scoped tools, not one generic endpoint
- background AI expands alongside Trussen AI instead of lagging behind it
- suggestions and confirmations are user-facing and implementation details remain hidden
- conversations preserve pending action state across turns
- high-impact actions require explicit confirmation before execution
- retries and reconnects do not create duplicate mutations
- AI actions are traceable in audit/activity history with actor attribution
- test coverage includes ambiguous, incomplete, and unauthorized prompts

---

## 12. Final Recommendation

Do not market the side-panel AI as “can do everything in the app” yet.

The right sequence is:

1. close the coverage gap with explicit tools
2. add deterministic slot filling and clarification state
3. expand analytics into first-class scoped tools
4. hide internal implementation details completely
5. only then position Trussen AI as the main operator for the workspace

The biggest engineering priority is not adding more prompt text.

It is:

- structured action schemas
- permission-safe tool expansion
- permanent no-delete enforcement
- deterministic clarification logic
- proper analytics tool decomposition
- shared evolution of Trussen AI and Background AI

That is what will make the AI reliable across the hundreds of edge cases users will naturally hit.
