import test from "node:test";
import assert from "node:assert/strict";
import { getAccessPlan, hasPaidAccess } from "./billing.service.js";

test("only ACTIVE, TRIALING and PAST_DUE count as paid access", () => {
  assert.equal(hasPaidAccess("ACTIVE"), true);
  assert.equal(hasPaidAccess("TRIALING"), true);
  assert.equal(hasPaidAccess("PAST_DUE"), true);

  for (const status of ["INCOMPLETE", "UNPAID", "CANCELED", "NONE"] as const) {
    assert.equal(hasPaidAccess(status as never), false, `${status} should not grant paid access`);
  }
});

test("an unpaid subscription resolves to FREE however its plan is stored (F-29)", () => {
  // Stripe's `default_incomplete` leaves plan=STANDARD with status=INCOMPLETE.
  // Comparing the stored plan let an owner exceed the member cap without paying.
  assert.equal(getAccessPlan("STANDARD", "INCOMPLETE"), "FREE");
  assert.equal(getAccessPlan("PREMIUM", "INCOMPLETE"), "FREE");
  assert.equal(getAccessPlan("PREMIUM", "UNPAID"), "FREE");
  assert.equal(getAccessPlan("PREMIUM", "CANCELED"), "FREE");
});

test("a genuinely paid subscription keeps its plan", () => {
  assert.equal(getAccessPlan("STANDARD", "ACTIVE"), "STANDARD");
  assert.equal(getAccessPlan("PREMIUM", "TRIALING"), "PREMIUM");
  // Past due still has access — a failed charge should not instantly lock a
  // customer out mid-cycle.
  assert.equal(getAccessPlan("PREMIUM", "PAST_DUE"), "PREMIUM");
});
