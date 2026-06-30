import test from "node:test";
import assert from "node:assert/strict";

import {
  addRecentReference,
  buildResolverContextFromMemory,
  createEmptyConversationMemory,
  rememberResolvedEntity,
  updateConversationMemoryFromUserMessage,
} from "./ai.memory.js";

test("conversation memory keeps latest resolved entities and current scope", () => {
  let memory = createEmptyConversationMemory();
  memory = rememberResolvedEntity(memory, {
    entityType: "project",
    entityId: "p1",
    name: "Ridely App",
  });
  memory = rememberResolvedEntity(memory, {
    entityType: "member",
    entityId: "u1",
    name: "Shaheer",
  });
  memory = addRecentReference(memory, "it");

  const context = buildResolverContextFromMemory(memory);
  assert.equal(context?.projectId, "p1");
  assert.equal(context?.memberId, "u1");
  assert.deepEqual(memory.recentReferences, ["it"]);
});

test("conversation memory keeps newest scoped entities across longer histories", () => {
  let memory = createEmptyConversationMemory();

  for (let index = 0; index < 12; index += 1) {
    memory = rememberResolvedEntity(memory, {
      entityType: "project",
      entityId: `p${index}`,
      name: `Project ${index}`,
    });
  }

  memory = rememberResolvedEntity(memory, {
    entityType: "issue",
    entityId: "FIS-99",
    name: "Critical auth bug",
  });

  const context = buildResolverContextFromMemory(memory);
  assert.equal(context?.projectId, "p11");
  assert.equal(context?.issueId, "FIS-99");
  assert.ok(memory.lastResolvedEntities.length <= 8);
});

test("conversation memory persists inferred language and references across long histories", () => {
  let memory = createEmptyConversationMemory();

  for (let index = 0; index < 60; index += 1) {
    memory = updateConversationMemoryFromUserMessage(memory, index % 2 === 0 ? "assign it to Ali" : "move that to review");
    memory = rememberResolvedEntity(memory, {
      entityType: "issue",
      entityId: `FIS-${index}`,
      name: `Issue ${index}`,
    });
  }

  memory = updateConversationMemoryFromUserMessage(memory, "رائیڈلی کی رپورٹ دو");

  assert.equal(memory.language, "ar");
  assert.ok((memory.recentReferences ?? []).includes("it"));
  assert.ok((memory.recentReferences ?? []).includes("that"));
  assert.ok(memory.lastResolvedEntities.length <= 8);
});
