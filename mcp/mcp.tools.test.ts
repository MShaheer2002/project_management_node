import test from "node:test";
import assert from "node:assert/strict";
import { MCP_TOOL_SPECS } from "./mcp.tools.js";

test("every defined tool is registered — no hidden allowlist gate", () => {
  assert.deepEqual(
    MCP_TOOL_SPECS.map((spec) => spec.name).sort(),
    [
      "add_comment",
      "assign_issue",
      "create_cycle",
      "create_department",
      "create_issue",
      "create_project",
      "create_team",
      "get_cycle_analytics",
      "get_issue",
      "get_member_analytics",
      "get_project_analytics",
      "get_project_summary",
      "get_team_analytics",
      "get_team_workload",
      "get_workspace_analytics",
      "list_cycles",
      "list_departments",
      "list_issues",
      "list_members",
      "list_projects",
      "list_teams",
      "search_issues",
      "update_cycle",
      "update_department",
      "update_issue",
      "update_issue_status",
      "update_project",
      "update_team",
    ].sort(),
  );
});

test("every tool declares a scope", () => {
  for (const spec of MCP_TOOL_SPECS) {
    assert.ok(spec.scope, `${spec.name} is missing a scope`);
  }
});
