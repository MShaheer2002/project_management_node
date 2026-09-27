import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../shared/utils/prisma.js";
import { createComment, MAX_MENTIONS_PER_COMMENT } from "./comment.service.js";

const tag = (count: number) => Array.from({ length: count }, (_, i) => `@[u](user_${i})`).join(" ");

function stubIssueAndCapture() {
  let created = false;
  prisma.issue.findFirst = (async () => ({ id: "W-1" })) as never;
  prisma.comment.create = (async () => { created = true; throw new Error("stop after create"); }) as never;
  return () => created;
}

test("a comment mentioning more than the limit is refused before it is stored (F-38)", async () => {
  const wasCreated = stubIssueAndCapture();
  await assert.rejects(
    createComment("ws", { userId: "user_me", role: "MEMBER" }, "W-1", "user_me", { body: tag(MAX_MENTIONS_PER_COMMENT + 1) } as never),
    (error: { code?: string; statusCode?: number }) => error.code === "MENTION_LIMIT_EXCEEDED" && error.statusCode === 422,
  );
  assert.equal(wasCreated(), false);
});

test("exactly the limit, plus self-mentions and repeats, is allowed", async () => {
  const wasCreated = stubIssueAndCapture();
  const body = `${tag(MAX_MENTIONS_PER_COMMENT)} @[me](user_me) ${tag(5)}`;
  await assert.rejects(createComment("ws", { userId: "user_me", role: "MEMBER" }, "W-1", "user_me", { body } as never), /stop after create/);
  assert.equal(wasCreated(), true, "reached the insert, so the cap let it through");
});
