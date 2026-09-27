import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_MODEL_DEFAULT, ISSUE_MODEL_DEFAULT, fallbackChainForPrimary, isFreeModel, usableFallbacks } from "./ai.provider.js";

test("free models are never automatic fallbacks unless explicitly allowed (F-42)", () => {
  const configured = ["google/gemini-3.5-flash-20260519", "qwen/qwen3-coder:free", undefined, "", "google/gemini-3.5-flash-20260519"];
  assert.deepEqual(usableFallbacks(configured, false), ["google/gemini-3.5-flash-20260519"], "free dropped, blanks and duplicates removed");
  assert.deepEqual(usableFallbacks(configured, true), ["google/gemini-3.5-flash-20260519", "qwen/qwen3-coder:free"]);
  assert.deepEqual(usableFallbacks([undefined, undefined], false), [], "nothing configured means no fallback");
});

test("the chains the app actually uses contain no free model", () => {
  for (const primary of [CHAT_MODEL_DEFAULT, ISSUE_MODEL_DEFAULT, "some/other-model"]) {
    const chain = fallbackChainForPrimary(primary);
    assert.equal(chain[0], primary, "the requested model is tried first");
    assert.ok(!chain.slice(1).some(isFreeModel), `free fallback in ${JSON.stringify(chain)}`);
  }
});

test("a model someone picked on purpose is still used as given", () => {
  assert.equal(fallbackChainForPrimary("qwen/qwen3-coder:free")[0], "qwen/qwen3-coder:free");
});
