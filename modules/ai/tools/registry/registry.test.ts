import assert from "node:assert/strict";
import { test } from "node:test";

import { AI_TOOLS } from "../tool-definitions.js";
import { CONSOLIDATED_TOOLS, createRegistryExecutor, getToolsForSurface, getRegistryStats } from "./index.js";

/**
 * Legacy capabilities the consolidated registry deliberately does not expose,
 * each for a stated reason. Anything else disappearing is a regression, not a
 * design choice — that's what the coverage test below is for.
 */
const INTENTIONALLY_DROPPED: Record<string, string> = {
  // Folded into issues_search via filters/grouping rather than separate tools.
  search_issues: "issues_search with query",
  get_team_workload: "issues_search with groupBy=assignee",
  prioritize_tasks: "issues_search with sort=priority",
  upcoming_deadlines: "issues_search with sort=dueDate",
  compare_projects: "analytics_report called per project",
  // Folded into a single action-parameterized tool.
  update_issue_status: "issues_update with status",
  assign_issue: "issues_update with assignee",
  add_label_to_issue: "issues_update with addLabels",
  remove_member: "members_manage with action=remove",
  // Not a capability — a refusal path that belongs in the boundary layer.
  policy_block: "handled by ai.boundary checkDestructiveIntent",
};

/** Maps each legacy tool to the consolidated tool that now covers it. */
const COVERAGE: Record<string, string> = {
  list_issues: "issues_search",
  get_issue: "issues_get",
  create_issue: "issues_create",
  update_issue: "issues_update",
  add_comment: "issues_comment",
  create_subtask: "issues_subtasks",
  update_subtask: "issues_subtasks",
  reorder_subtasks: "issues_subtasks",
  add_issue_watchers: "issues_watchers",
  list_issue_watchers: "issues_watchers",
  add_issue_dependency: "issues_links",
  update_issue_integration_ref: "issues_links",

  list_projects: "projects_search",
  get_project_summary: "projects_get",
  create_project: "projects_create",
  update_project: "projects_update",
  list_project_members: "members_manage",
  add_project_members: "members_manage",
  remove_project_member: "members_manage",

  list_teams: "teams_search",
  get_team: "teams_get",
  create_team: "teams_create",
  update_team: "teams_update",
  list_team_members: "members_manage",
  add_team_members: "members_manage",
  remove_team_member: "members_manage",
  list_members: "members_manage",

  list_departments: "departments_search",
  get_department: "departments_get",
  create_department: "departments_create",
  update_department: "departments_update",
  list_department_members: "members_manage",
  add_department_members: "members_manage",
  remove_department_member: "members_manage",

  get_workspace: "workspace_get",
  update_workspace: "workspace_update",
  update_workspace_statuses: "workspace_update",
  get_workspace_access_summary: "workspace_get",
  list_user_workspaces: "workspace_list_mine",
  list_workspace_members: "members_manage",
  change_workspace_member_role: "members_manage",
  remove_workspace_member: "members_manage",
  invite_member: "workspace_invitations",
  list_workspace_invitations: "workspace_invitations",
  list_pending_workspace_invites: "workspace_invitations",
  accept_workspace_invite: "workspace_invitations",

  list_cycles: "cycles_search",
  get_current_cycle_for_team: "cycles_search",
  get_cycle: "cycles_get",
  get_cycle_progress: "cycles_get",
  create_cycle: "cycles_create",
  update_cycle: "cycles_update",
  complete_cycle: "cycles_update",
  reopen_cycle: "cycles_update",
  carry_over_cycle: "cycles_update",

  list_templates: "templates_search",
  list_active_templates: "templates_search",
  get_template: "templates_get",
  create_template: "templates_manage",
  update_template: "templates_manage",
  duplicate_template: "templates_manage",
  activate_template: "templates_manage",
  deactivate_template: "templates_manage",

  list_documents: "documents_search",
  list_document_folders: "documents_search",
  create_document: "documents_create",
  create_document_folder: "documents_create",
  update_document: "documents_update",
  move_document: "documents_update",
  rename_document_folder: "documents_update",
  move_document_folder: "documents_update",

  list_roadmap: "roadmap_get",
  get_project_roadmap: "roadmap_get",
  update_project_schedule: "roadmap_schedule",
  create_milestone: "roadmap_milestones",
  update_milestone: "roadmap_milestones",
  reorder_milestones: "roadmap_milestones",
  create_roadmap_dependency: "roadmap_dependencies",
  resolve_roadmap_dependency: "roadmap_dependencies",
  cancel_roadmap_dependency: "roadmap_dependencies",

  get_workspace_analytics: "analytics_report",
  get_project_analytics: "analytics_report",
  get_team_analytics: "analytics_report",
  get_member_analytics: "analytics_report",
  get_cycle_analytics: "analytics_report",
  export_analytics_report: "analytics_export",

  list_notifications: "notifications_manage",
  mark_notification_read: "notifications_manage",
  mark_all_notifications_read: "notifications_manage",

  list_api_keys: "api_keys_manage",
  get_api_key: "api_keys_manage",
  create_api_key: "api_keys_manage",
  list_integrations: "integrations_get",
  get_integration_status: "integrations_get",

  list_labels: "labels_search",
  activity_summary: "activity_search",
  app_help: "app_help",
};

test("every legacy tool is either covered or explicitly dropped", () => {
  const consolidatedNames = new Set(CONSOLIDATED_TOOLS.map((tool) => tool.name));
  const uncovered: string[] = [];

  for (const legacy of AI_TOOLS) {
    const name = legacy.function.name;
    if (name in INTENTIONALLY_DROPPED) continue;

    const replacement = COVERAGE[name];
    if (!replacement) {
      uncovered.push(`${name} (no mapping)`);
      continue;
    }
    if (!consolidatedNames.has(replacement)) {
      uncovered.push(`${name} → ${replacement} (replacement missing from registry)`);
    }
  }

  assert.deepEqual(uncovered, [], "legacy capabilities lost in consolidation");
});

test("every intentional drop names a real replacement path", () => {
  const consolidatedNames = new Set(CONSOLIDATED_TOOLS.map((tool) => tool.name));

  for (const [dropped, reason] of Object.entries(INTENTIONALLY_DROPPED)) {
    if (dropped === "policy_block") continue; // boundary layer, not a tool
    const target = reason.split(" ")[0]!;
    assert.ok(
      consolidatedNames.has(target),
      `${dropped} claims to be replaced by ${target}, which is not in the registry`,
    );
  }
});

test("consolidation meaningfully reduces the tool surface", () => {
  const stats = getRegistryStats();
  assert.ok(stats.total < AI_TOOLS.length / 2, `expected fewer than half of ${AI_TOOLS.length}, got ${stats.total}`);
  assert.ok(stats.total >= 40, "suspiciously few tools — a domain may have failed to load");
});

test("tool names are unique and namespaced", () => {
  const names = CONSOLIDATED_TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool names");

  for (const name of names) {
    assert.match(name, /^[a-z][a-z0-9_]*$/, `${name} is not snake_case`);
    assert.ok(name.includes("_"), `${name} is not namespaced as domain_action`);
  }
});

test("every tool declares complete, well-formed parameters", () => {
  for (const tool of CONSOLIDATED_TOOLS) {
    assert.equal(tool.parameters.type, "object", `${tool.name} parameters must be an object`);
    assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`);

    for (const required of tool.parameters.required ?? []) {
      assert.ok(
        required in tool.parameters.properties,
        `${tool.name} requires "${required}" but does not define it`,
      );
    }
  }
});

test("no delete-shaped tool exists anywhere in the registry", () => {
  for (const tool of CONSOLIDATED_TOOLS) {
    assert.doesNotMatch(tool.name, /delete|destroy|purge|wipe/i, `${tool.name} looks destructive`);

    const enums = Object.values(tool.parameters.properties).flatMap((prop) => prop.enum ?? []);
    for (const value of enums) {
      assert.doesNotMatch(String(value), /^(delete|destroy|purge|wipe)$/i, `${tool.name} exposes a ${value} action`);
    }
  }
});

// ─── Surface boundaries ─────────────────────────────────────────────────────

test("background AI and the assistant bubble cannot mutate anything", () => {
  for (const surface of ["background", "assistant"] as const) {
    for (const tool of getToolsForSurface(surface)) {
      assert.ok(tool.readOnly, `${tool.name} is writable but exposed to the ${surface} surface`);
    }
  }
});

test("the panel keeps the full surface", () => {
  assert.equal(getToolsForSurface("panel").length, CONSOLIDATED_TOOLS.length);
});

test("executor rejects tools outside the surface's allowlist", async () => {
  const execute = createRegistryExecutor("background");
  const ctx = { workspaceId: "ws-1", userId: "u-1", userRole: "MEMBER" };

  const result = await execute("issues_update", { issueId: "TRU-1" }, ctx);

  assert.equal(result.success, false, "a write tool must be unreachable from the background surface");
  assert.match(result.error ?? "", /unknown or unavailable/i);
});

test("executor rejects hallucinated tool names without throwing", async () => {
  const execute = createRegistryExecutor("panel");
  const ctx = { workspaceId: "ws-1", userId: "u-1", userRole: "OWNER" };

  const result = await execute("issues_teleport", {}, ctx);

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /unknown or unavailable/i);
});

// ─── Argument handling ──────────────────────────────────────────────────────

test("ask_user_to_clarify parses options and flags that input is awaited", async () => {
  const execute = createRegistryExecutor("panel");
  const ctx = { workspaceId: "ws-1", userId: "u-1", userRole: "MEMBER" };

  const result = await execute(
    "ask_user_to_clarify",
    { question: "Which team?", options: '["Backend Team","Backend Platform"]' },
    ctx,
  );

  assert.equal(result.success, true);
  assert.deepEqual((result.payload as { options: string[] }).options, ["Backend Team", "Backend Platform"]);
  assert.equal(result.meta?.awaitingUserInput, true);
});

test("ask_user_to_clarify degrades to open-ended on malformed options", async () => {
  const execute = createRegistryExecutor("panel");
  const ctx = { workspaceId: "ws-1", userId: "u-1", userRole: "MEMBER" };

  const result = await execute("ask_user_to_clarify", { question: "Which one?", options: "[not json" }, ctx);

  assert.equal(result.success, true, "a malformed option list must not fail the turn");
  assert.deepEqual((result.payload as { options: string[] }).options, []);
});

test("tools requiring an id fail cleanly when it is missing", async () => {
  const execute = createRegistryExecutor("panel");
  const ctx = { workspaceId: "ws-1", userId: "u-1", userRole: "OWNER" };

  for (const [tool, args] of [
    ["issues_get", {}],
    ["issues_update", { issueId: "" }],
    ["projects_get", {}],
    ["analytics_report", { scope: "project" }],
  ] as const) {
    const result = await execute(tool, args as Record<string, unknown>, ctx);
    assert.equal(result.success, false, `${tool} should reject a missing identifier`);
    assert.ok((result.error ?? "").length > 0, `${tool} should explain what is missing`);
  }
});

test("analytics_report does not require a scopeId for workspace scope", async () => {
  const execute = createRegistryExecutor("panel");
  const ctx = { workspaceId: "ws-1", userId: "u-1", userRole: "MEMBER" };

  const result = await execute("analytics_report", { scope: "workspace" }, ctx);

  // Reaches the executor (and is refused there for a non-admin) rather than
  // being rejected up front for a missing scopeId.
  assert.doesNotMatch(result.error ?? "", /scopeId is required/);
});
