# Phase 20K Appendix — Tool Consolidation Map

> Appendix to [phase20k-ai-redesign-spec.md](./phase20k-ai-redesign-spec.md).
> **Purpose: prove zero capability loss.** Every one of the 107 current executor capabilities maps to a consolidated tool. Nothing is dropped.

---

## 0. The real starting number is 107, not 100

`tool-definitions.ts` exposes **100** tools to the model. `tool-executor.ts` implements **107** cases. The extra 7 are reachable *only* when a hardcoded keyword rule fires a canned plan — **the model cannot choose them:**

`prioritize_tasks` · `compare_projects` · `upcoming_deadlines` · `activity_summary` · `app_help` · `remove_member` · `policy_block`

This matters for sequencing: **deleting the keyword layer without consolidating would silently remove these capabilities.** They must be folded into the model-visible toolset first.

---

## 1. Result

| | Now | After |
|---|---|---|
| Executor capabilities | 107 | 107 (zero loss) |
| Model-visible tools | 100 | **~45** |
| Model-*unreachable* capabilities | 7 | **0** |

**Honest correction to the spec:** I estimated "~30" before doing this analysis. The real number is **~45**. Forcing it to 30 would require merging entity types (projects/teams/departments) into generic `groups_*` tools, which trades a tool-selection problem for an entity-confusion problem — worse. 100 → 45 still captures the large majority of the benefit.

---

## 2. Issues — 20 → 8

| New tool | Replaces | Notes |
|---|---|---|
| `issues_search` | `list_issues`, `search_issues`, `get_team_workload`, `prioritize_tasks`, `upcoming_deadlines` | Filters: `q`, assignee (incl. `unassigned`), status, priority, type, project, team, cycle, `overdue`, `blocked`, `due_within`. Plus `group_by: assignee\|status\|priority\|project` and `sort`. **`group_by: assignee` reproduces `get_team_workload` at any scope**; `sort: priority_score` reproduces `prioritize_tasks`; `due_within` reproduces `upcoming_deadlines`. |
| `issues_get` | `get_issue` | Single-entity detail. Kept separate — distinct response shape, very high frequency. |
| `issues_create` | `create_issue` | Routes through `issueService.createIssue` (already fixed). |
| `issues_update` | `update_issue`, `update_issue_status`, `assign_issue`, `add_label_to_issue` | All optional fields in one call. **Fixes a real bug class:** `update_issue_status` was implemented as a forward into `update_issue`, which is what bypassed the approval gate. Routes through `issueService.updateIssue` / `updateIssueStatus`. |
| `issues_comment` | `add_comment` | Routes through `commentService.createComment` (restores @mention notifications). |
| `issues_subtasks` | `create_subtask`, `update_subtask`, `reorder_subtasks` | `action: create\|update\|reorder`. |
| `issues_watchers` | `add_issue_watchers`, `list_issue_watchers` | `action: list\|add`. |
| `issues_links` | `add_issue_dependency`, `update_issue_integration_ref` | `kind: dependency\|integration_ref`. **Fixes the data-loss bug** — integration refs merge instead of replace. |

**New capability unlocked:** `issues_approvals` (approve/revoke a gated transition) — REST supports it, AI never has. Add as a 9th tool if we want approval coverage.

---

## 3. Projects / Teams / Departments — 22 → 13

Deliberately kept **parallel in shape** across the three entity types. Parallel naming helps the model generalize; merging into generic `groups_*` does not.

| New tool | Replaces |
|---|---|
| `projects_search` | `list_projects` |
| `projects_get` | `get_project_summary` |
| `projects_create` | `create_project` |
| `projects_update` | `update_project` (+ archive/complete via `status`) |
| `teams_search` | `list_teams` |
| `teams_get` | `get_team` |
| `teams_create` | `create_team` |
| `teams_update` | `update_team` |
| `departments_search` | `list_departments` |
| `departments_get` | `get_department` |
| `departments_create` | `create_department` |
| `departments_update` | `update_department` |
| **`members_manage`** | `list_project_members`, `add_project_members`, `remove_project_member`, `list_team_members`, `add_team_members`, `remove_team_member`, `list_department_members`, `add_department_members`, `remove_department_member`, `list_workspace_members`, `change_workspace_member_role`, `remove_workspace_member`, `remove_member` | `container: project\|team\|department\|workspace` + `action: list\|add\|remove\|change_role`. **13 → 1.** The single biggest consolidation win; all four containers do the identical operation. AuthZ still resolved per container type at execution. |

**Gap this closes:** `update_project` currently can't change lead/team/visibility (flagged in the audit). `projects_update` supports the full service surface.

---

## 4. Workspace & invitations — 8 → 4

| New tool | Replaces |
|---|---|
| `workspace_get` | `get_workspace`, `get_workspace_access_summary` |
| `workspace_update` | `update_workspace`, `update_workspace_statuses` |
| `workspace_list_mine` | `list_user_workspaces` |
| `invitations_manage` | `invite_member`, `list_workspace_invitations`, `list_pending_workspace_invites`, `accept_workspace_invite` (`action: create\|list\|list_pending\|accept`) |

---

## 5. Cycles — 9 → 4 · Templates — 8 → 4

| New tool | Replaces |
|---|---|
| `cycles_search` | `list_cycles`, `get_current_cycle_for_team` |
| `cycles_get` | `get_cycle`, `get_cycle_progress` (progress via `response_format: detailed`) |
| `cycles_create` | `create_cycle` |
| `cycles_update` | `update_cycle`, `complete_cycle`, `reopen_cycle`, `carry_over_cycle` (`action:`) — reopen keeps its stricter ADMIN/OWNER check at execution |
| `templates_search` | `list_templates`, `list_active_templates` |
| `templates_get` | `get_template` |
| `templates_create` | `create_template`, `duplicate_template` (`source_id?`) |
| `templates_update` | `update_template`, `activate_template`, `deactivate_template` — **must route through `confirmActivateTemplate`**, fixing the swap-confirmation dead end from the audit |

---

## 6. Documents — 8 → 3 · Roadmap — 9 → 4

| New tool | Replaces |
|---|---|
| `documents_search` | `list_documents`, `list_document_folders` (`kind: document\|folder`) |
| `documents_create` | `create_document`, `create_document_folder` |
| `documents_update` | `update_document`, `move_document`, `rename_document_folder`, `move_document_folder` |
| `roadmap_get` | `list_roadmap`, `get_project_roadmap` |
| `roadmap_schedule` | `update_project_schedule` |
| `roadmap_milestones` | `create_milestone`, `update_milestone`, `reorder_milestones` |
| `roadmap_dependencies` | `create_roadmap_dependency`, `resolve_roadmap_dependency`, `cancel_roadmap_dependency` — all gated by `hasDependencyManageAccess` (fixed tonight) |

---

## 7. Analytics — 8 → 2

| New tool | Replaces |
|---|---|
| **`analytics_report`** | `get_workspace_analytics`, `get_project_analytics`, `get_team_analytics`, `get_member_analytics`, `get_cycle_analytics`, `compare_projects` | 
| `analytics_export` | `export_analytics_report` |

`analytics_report(scope: workspace|project|team|member|cycle, scope_ref?, period?, compare_to?)`.

**This is the consolidation that structurally fixes the "who is most stressed as a team" bug.** Today, picking `get_team_analytics` is an unrecoverable fork — the model then can't resolve a team and loops asking "Which team?", with no path back to workspace scope because that's a *different tool*. With one tool, `scope` is a parameter: answering "overall workspace" simply fills it. The scope-override patch I wrote becomes unnecessary.

Each scope keeps its own authz at execution (workspace = ADMIN/OWNER; others = MEMBER+ narrowed by `assert*AnalyticsAccess`).

---

## 8. Remaining — 9 → 5

| New tool | Replaces |
|---|---|
| `notifications_manage` | `list_notifications`, `mark_notification_read`, `mark_all_notifications_read` |
| `api_keys_manage` | `list_api_keys`, `get_api_key`, `create_api_key` (`action:`; secret-safe replay preserved) |
| `integrations_get` | `list_integrations`, `get_integration_status` |
| `labels_search` | `list_labels` |
| `activity_search` | `activity_summary` — **currently model-unreachable**; also fixes the `Activity.message` → `description` bug |

---

## 9. New tools (capability additions)

| Tool | Why |
|---|---|
| **`ask_user_to_clarify(question, options[])`** | Research shows models recognize ambiguity but rarely act on it. Makes clarification a selectable action, renders as UI chips, assertable in evals. Replaces the entire slot-filling state machine. |
| **`app_help`** | Exists in executor, model-unreachable today. Powers the assistance bubble. |
| `issues_approvals` | Optional — closes the approval-workflow gap found in the audit. |

`policy_block` and `remove_member` are **not** tools — the first is a refusal path (belongs in the boundary layer, not the toolset), the second folds into `members_manage`.

---

## 10. Tally

| Domain | Now | After |
|---|---|---|
| Issues | 20 | 8 |
| Projects / Teams / Departments (+ all membership) | 22 | 13 |
| Workspace & invitations | 8 | 4 |
| Cycles | 9 | 4 |
| Templates | 8 | 4 |
| Documents | 8 | 3 |
| Roadmap | 9 | 4 |
| Analytics | 8 | 2 |
| Notifications / API keys / Integrations / Labels / Activity | 9 | 5 |
| New (`ask_user_to_clarify`, `app_help`) | 0 | 2 |
| Refusal path (`policy_block`) | 1 | 0 (boundary layer) |
| **Total** | **107** | **~49** |

---

## 11. What consolidation *adds*

Not just fewer names — real capability that doesn't exist today:

1. **Multi-field updates in one call.** "Set VAT-42 to high priority, assign to Sara, move to in-progress" is 3 tool calls today; 1 after.
2. **Workload at any scope.** `issues_search(group_by: assignee)` works for a project, a cycle, or the workspace. Today `get_team_workload` only does team-or-everything.
3. **Scope becomes correctable mid-conversation** (§7) — removes a whole bug class rather than patching it.
4. **7 orphaned capabilities become model-reachable** for the first time.
5. **Grouping/sorting compose freely.** Today each combination needs its own hardcoded tool; `prioritize_tasks` and `upcoming_deadlines` exist only because `list_issues` couldn't sort or filter that way.
6. **Audit gaps close naturally** — project lead reassignment, template activation swap, integration-ref merge, activity search.

---

## 12. The honest tradeoff

Consolidated tools have **larger parameter schemas**, which moves some risk from *tool selection* to *parameter correctness*. Mitigations:

- Hard `enum`s on every canonical value (also fixes multilingual parameter leakage).
- `response_format: concise|detailed` to control token cost.
- Human-readable identifiers alongside IDs in every result.
- Paraphrase-set evals asserting correct parameters, not just correct tool.

This is why the target is ~49 and not ~30: past a point, merging trades one failure mode for a worse one.
