import test from "node:test";
import assert from "node:assert/strict";
import { hasScope } from "../../shared/utils/scopes.js";

test("legacy/placeholder connections stay unrestricted", () => {
  assert.equal(hasScope(null, "issues:write"), true);
  assert.equal(hasScope(undefined, "issues:write"), true);
  assert.equal(hasScope([], "issues:write"), true);
  assert.equal(hasScope(["mcp:v1"], "issues:write"), true);
});

test("admin scope is a wildcard", () => {
  assert.equal(hasScope(["admin"], "issues:write"), true);
  assert.equal(hasScope(["admin"], "some:future:scope"), true);
});

test("real scopes only grant what they name", () => {
  assert.equal(hasScope(["issues:read"], "issues:read"), true);
  assert.equal(hasScope(["issues:read"], "issues:write"), false);
  assert.equal(hasScope(["issues:read", "projects:write"], "projects:write"), true);
});
