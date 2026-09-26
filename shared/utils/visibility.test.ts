import test from "node:test";
import assert from "node:assert/strict";
import { visibleIssueWhere, visibleProjectWhere, isWorkspaceAdmin } from "./visibility.js";

test("admins are unrestricted, everyone else is filtered", () => {
  for (const role of ["OWNER", "ADMIN"] as const) {
    assert.equal(isWorkspaceAdmin(role), true);
    assert.deepEqual(visibleIssueWhere({ userId: "u1", role }), {});
    assert.deepEqual(visibleProjectWhere({ userId: "u1", role }), {});
  }
});

test("GUEST and MEMBER only reach public projects, ones they lead, or ones they joined (F-06)", () => {
  for (const role of ["GUEST", "MEMBER"] as const) {
    assert.deepEqual(visibleIssueWhere({ userId: "u1", role }), {
      OR: [
        { project: { visibility: "PUBLIC" } },
        { project: { leadId: "u1" } },
        { project: { memberships: { some: { userId: "u1" } } } },
      ],
    });
    assert.deepEqual(visibleProjectWhere({ userId: "u1", role }), {
      OR: [
        { visibility: "PUBLIC" },
        { leadId: "u1" },
        { memberships: { some: { userId: "u1" } } },
      ],
    });
  }
});

test("a non-admin filter is never empty — an empty spread would widen the query to everything", () => {
  // The whole failure mode of F-06: a `where` that silently matches all rows.
  assert.notDeepEqual(visibleIssueWhere({ userId: "u1", role: "GUEST" }), {});
  assert.notDeepEqual(visibleProjectWhere({ userId: "u1", role: "MEMBER" }), {});
});
