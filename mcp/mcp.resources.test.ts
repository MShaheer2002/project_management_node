import test from "node:test";
import assert from "node:assert/strict";
import { MCP_TOOL_SPECS } from "./mcp.tools.js";
import { hasScope } from "../shared/utils/scopes.js";

// The tools each trussen:// resource is backed by (mcp.resources.ts).
const RESOURCE_TOOLS = [
  "get_workspace_analytics",
  "list_cycles",
  "get_issue",
  "get_project_summary",
  "get_project_analytics",
];

test("every resource-backed tool declares a scope, so none is allowed by omission", () => {
  const declared = new Map(MCP_TOOL_SPECS.map((spec) => [spec.name, spec.scope] as const));
  for (const tool of RESOURCE_TOOLS) {
    assert.ok(declared.get(tool), `${tool} backs a resource but has no scope in MCP_TOOL_SPECS`);
  }
});

test("an issues:read connection cannot reach the analytics resources (F-09)", () => {
  const scopes = ["issues:read"];
  const declared = new Map(MCP_TOOL_SPECS.map((spec) => [spec.name, spec.scope] as const));

  assert.equal(hasScope(scopes, declared.get("get_issue")!), true);
  assert.equal(hasScope(scopes, declared.get("get_workspace_analytics")!), false);
  assert.equal(hasScope(scopes, declared.get("get_project_analytics")!), false);
  assert.equal(hasScope(scopes, declared.get("get_project_summary")!), false);
  assert.equal(hasScope(scopes, declared.get("list_cycles")!), false);
});
