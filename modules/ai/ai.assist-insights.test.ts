import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../../config/env.js";
import { isHelpInsightsStaff, maskQuestion } from "./ai.assist-insights.js";

test("questions are masked before they are stored", () => {
  assert.equal(maskQuestion("why can't I invite jane.doe+work@acme.co.uk?"), "why can't I invite [email]?");
  assert.equal(maskQuestion("my key lin_abcdef123456789 stopped working"), "my key [secret] stopped working");
  assert.equal(maskQuestion("see https://acme.trussen.app/issues/ACME-1?x=1 please"), "see [link] please");
  assert.equal(maskQuestion("call me on +1 (555) 123-4567"), "call me on [number]");
  assert.equal(maskQuestion("user user_2abcDEF345ghi can't log in"), "user [id] can't log in");
  assert.equal(maskQuestion("due 2026-10-03, issue ACME-12"), "due 2026-10-03, issue ACME-12", "dates and issue ids stay");
  assert.equal(maskQuestion("x".repeat(5_000)).length, 1_000);
});

test("only listed staff emails may open insights, case-insensitively", () => {
  (env as { HELP_INSIGHTS_STAFF_EMAILS: string[] }).HELP_INSIGHTS_STAFF_EMAILS = ["ops@trussen.app"];
  assert.equal(isHelpInsightsStaff("OPS@trussen.app"), true);
  assert.equal(isHelpInsightsStaff("someone@trussen.app"), false);
  assert.equal(isHelpInsightsStaff(undefined), false);
  (env as { HELP_INSIGHTS_STAFF_EMAILS: string[] }).HELP_INSIGHTS_STAFF_EMAILS = [];
  assert.equal(isHelpInsightsStaff("ops@trussen.app"), false, "empty list means nobody");
});
