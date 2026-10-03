/**
 * Tier 1 of the AI Assistance evaluation set, on every `npm test`: the case
 * file is valid, and every instant-answer case is answered correctly with no
 * database and no model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../shared/utils/prisma.js";
import { assist } from "../ai/ai.assist.js";
import { initHelpArticles } from "./help.service.js";
import { evalAssistIO, loadEvalCases, scoreAnswer, validateEvalCases } from "./help.eval.js";

initHelpArticles();
const cases = loadEvalCases();

// Instant answers must never search or call a model.
(prisma as unknown as { $queryRaw: () => never }).$queryRaw = () => {
  throw new Error("instant answers must not search the help index");
};

test("the evaluation set is valid: at least 80 cases, every expected article exists and is readable by that role", () => {
  assert.ok(cases.length >= 80, `only ${cases.length} cases`);
  assert.deepEqual(validateEvalCases(cases), []);
  for (const tag of ["instant", "how-to", "people", "plans", "integrations", "follow-up", "off-topic", "safety"]) {
    assert.ok(cases.some((item) => item.tags.includes(tag)), `no cases tagged ${tag}`);
  }
});

for (const item of cases.filter((candidate) => candidate.expect.instant)) {
  test(`instant: ${item.id}`, async () => {
    let reachedModelPath = false;
    const io = { ...evalAssistIO(item), loadHistory: async () => { reachedModelPath = true; return []; } };
    const response = await assist(
      { message: item.question, route: item.route, workspaceId: "eval", userId: "eval", userRole: item.role } as never,
      { io },
    );
    assert.equal(reachedModelPath, false, "went to the model instead of answering instantly");
    assert.deepEqual(scoreAnswer(item, response), []);
  });
}
