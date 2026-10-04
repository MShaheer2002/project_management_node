import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../../config/env.js";
import { prisma } from "../../shared/utils/prisma.js";
import { assertAiAccess, getAiAvailability } from "./ai.access.js";

function onPlan(plan: "FREE" | "STANDARD" | "PREMIUM") {
  prisma.subscription.findUnique = (async () => ({ plan, status: "ACTIVE" })) as never;
  prisma.aiWorkspaceUsageDaily.findUnique = (async () => null) as never;
  prisma.aiUserUsageDaily.findUnique = (async () => null) as never;
}

test("with billing enforced, Free and Standard get the help assistant but not Trussen AI", async () => {
  (env as { AI_ENFORCE_BILLING: boolean }).AI_ENFORCE_BILLING = true;
  for (const plan of ["FREE", "STANDARD"] as const) {
    onPlan(plan);
    await assertAiAccess({ workspaceId: "ws", userId: "u", feature: "assist" });
    for (const feature of ["chat", "issue_generation", "draft_suggestions"] as const) {
      await assert.rejects(assertAiAccess({ workspaceId: "ws", userId: "u", feature }), /Premium/, `${plan} ${feature}`);
    }
    assert.deepEqual(await getAiAvailability("ws"), { assistant: true, trussenAi: false });
  }

  onPlan("PREMIUM");
  await assertAiAccess({ workspaceId: "ws", userId: "u", feature: "chat" });
  assert.deepEqual(await getAiAvailability("ws"), { assistant: true, trussenAi: true });
});
