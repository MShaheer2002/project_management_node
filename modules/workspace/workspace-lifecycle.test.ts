import test from "node:test";
import assert from "node:assert/strict";
import { daysUntil, dueReminder } from "./workspace-lifecycle.service.js";
import { workspaceSignInUrl } from "../../infra/email/workspace-lifecycle-emails.js";

const DAY = 24 * 60 * 60 * 1000;
const purgeAt = new Date("2026-10-31T10:00:00Z");
const left = (ms: number) => new Date(purgeAt.getTime() - ms);

test("each countdown email becomes due at 15, 5 and 1 days left", () => {
  assert.equal(dueReminder(purgeAt, left(16 * DAY), null), null);
  assert.equal(dueReminder(purgeAt, left(15 * DAY), null), 15);
  assert.equal(dueReminder(purgeAt, left(5 * DAY), 15), 5);
  assert.equal(dueReminder(purgeAt, left(DAY), 5), 1);
});

test("a reminder already sent is not sent again", () => {
  assert.equal(dueReminder(purgeAt, left(14 * DAY), 15), null);
  assert.equal(dueReminder(purgeAt, left(12 * 60 * 60 * 1000), 1), null);
});

test("after an outage only the most urgent reminder goes out", () => {
  // Job down from day 14 to day 26: send "5 days left", not a stale "15 days".
  assert.equal(dueReminder(purgeAt, left(4 * DAY), null), 5);
  assert.equal(dueReminder(purgeAt, left(6 * 60 * 60 * 1000), null), 1);
});

test("nothing is due once the purge time has passed", () => {
  assert.equal(dueReminder(purgeAt, purgeAt, null), null);
  assert.equal(dueReminder(purgeAt, new Date(purgeAt.getTime() + DAY), null), null);
});

test("days left rounds up and never goes negative", () => {
  assert.equal(daysUntil(purgeAt, left(30 * DAY)), 30);
  assert.equal(daysUntil(purgeAt, left(DAY / 2)), 1);
  assert.equal(daysUntil(purgeAt, new Date(purgeAt.getTime() + DAY)), 0);
});

test("the restore link points at the workspace's own sign-in page", () => {
  const url = new URL(workspaceSignInUrl("acme"));
  assert.ok(url.hostname.startsWith("acme."), url.hostname);
  assert.equal(url.pathname, "/login");
});
