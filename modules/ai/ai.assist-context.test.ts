import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../shared/utils/prisma.js";
import { buildAssistContext, describeAssistContext } from "./ai.assist-context.js";

prisma.subscription.findUnique = (async () => ({ plan: "FREE", status: "ACTIVE", storageUsedBytes: 5 * 1024 ** 2 })) as never;
prisma.workspaceMembership.count = (async () => 8) as never;
prisma.workspaceInvitation.count = (async () => 1) as never;
prisma.integration.findMany = (async () => [{ provider: "SLACK" }]) as never;
prisma.userDriveConnection.findUnique = (async () => null) as never;

test("owners and admins see member and storage usage against the plan", async () => {
  const text = describeAssistContext(await buildAssistContext("ws", "u", "ADMIN"));
  assert.match(text, /Workspace plan: Free/);
  assert.match(text, /Members: 8 plus 1 pending invites, of a 10 limit \(1 left\)/);
  assert.match(text, /Storage: 5\.0 MB used of 2\.0 GB/);
  assert.match(text, /Connected integrations: Slack/);
  assert.match(text, /Google Drive: not connected/);
});

test("members don't get billing-only usage; guests don't get integrations either", async () => {
  const member = describeAssistContext(await buildAssistContext("ws", "u", "MEMBER"));
  assert.doesNotMatch(member, /Members:|Storage:/);
  assert.match(member, /Connected integrations: Slack/);

  const guest = describeAssistContext(await buildAssistContext("ws", "u", "GUEST"));
  assert.equal(guest, "Workspace plan: Free\nUser role: GUEST");
});
