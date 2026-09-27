import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_SCOPE, DEFAULT_OAUTH_SCOPES, ALL_SCOPES } from "./ai-connection.scopes.js";
import { hasScope } from "../../shared/utils/scopes.js";

test("the self-service default is read-only and never empty (F-11)", () => {
  // An empty list is a wildcard by accident: hasScope() returns true for it.
  assert.ok(DEFAULT_OAUTH_SCOPES.length > 0, "an empty default would be unrestricted");
  assert.equal(DEFAULT_OAUTH_SCOPES.includes(ADMIN_SCOPE), false);
  for (const scope of DEFAULT_OAUTH_SCOPES) {
    assert.ok(scope.endsWith(":read"), `${scope} is not read-only`);
    assert.ok((ALL_SCOPES as readonly string[]).includes(scope), `${scope} is not a real scope`);
  }
});

test("the default grants no write access", () => {
  for (const scope of ALL_SCOPES.filter((s) => s.endsWith(":write"))) {
    assert.equal(hasScope(DEFAULT_OAUTH_SCOPES, scope), false, `default should not grant ${scope}`);
  }
});

test("an empty scope list really is unrestricted — which is why we never store one", () => {
  // Pins the surprising hasScope() contract the default exists to avoid.
  assert.equal(hasScope([], "issues:write"), true);
  assert.equal(hasScope(DEFAULT_OAUTH_SCOPES, "issues:write"), false);
});
