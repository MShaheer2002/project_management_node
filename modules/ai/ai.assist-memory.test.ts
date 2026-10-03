import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_HISTORY_CHARS, MODEL_HISTORY_MESSAGES, trimForModel, type AssistHistoryMessage } from "./ai.assist-memory.js";

const turn = (n: number, size = 10): AssistHistoryMessage[] => [
  { role: "user", content: `q${n}`.padEnd(size, ".") },
  { role: "assistant", content: `a${n}`.padEnd(size, ".") },
];

test("the model gets at most the last six questions and answers, oldest first", () => {
  const history = Array.from({ length: 10 }, (_, i) => turn(i)).flat();
  const kept = trimForModel(history);
  assert.equal(kept.length, MODEL_HISTORY_MESSAGES);
  assert.ok(kept[0]!.content.startsWith("q4"));
  assert.ok(kept.at(-1)!.content.startsWith("a9"));
});

test("long messages are dropped from the old end to stay within the character budget", () => {
  const history = [...turn(1, 3_000), ...turn(2, 1_000)];
  const kept = trimForModel(history);
  assert.ok(kept.reduce((sum, m) => sum + m.content.length, 0) <= MODEL_HISTORY_CHARS);
  assert.deepEqual(kept.map((m) => m.content[1]), ["2", "2"]);
});

test("history never starts with an answer whose question was cut off", () => {
  const kept = trimForModel([{ role: "assistant", content: "orphan" }, ...turn(1)]);
  assert.equal(kept[0]!.role, "user");
  assert.deepEqual(trimForModel([]), []);
});
