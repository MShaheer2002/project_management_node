import test from "node:test";
import assert from "node:assert/strict";
import { V1_MCP_TOOL_NAMES, V1_MCP_TOOL_SPECS } from "./mcp.tools.js";

test("V1 MCP allowlist only exposes the planned safe tool set", () => {
  assert.deepEqual(
    [...V1_MCP_TOOL_NAMES],
    [
      "list_issues",
      "get_issue",
      "create_issue",
      "update_issue_status",
      "assign_issue",
      "add_comment",
      "list_projects",
      "list_cycles",
      "list_members",
      "search_issues",
    ],
  );
});

test("V1 MCP tool specs match the V1 allowlist exactly", () => {
  assert.deepEqual(
    V1_MCP_TOOL_SPECS.map((spec) => spec.name),
    [...V1_MCP_TOOL_NAMES],
  );
});
