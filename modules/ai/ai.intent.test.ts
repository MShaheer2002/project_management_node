import test from "node:test";
import assert from "node:assert/strict";

import { classifyAiIntent, classifyAiIntentHybrid } from "./ai.intent.js";

test("classifies typo-heavy role question semantically", () => {
  const result = classifyAiIntent("tell me what is my rle");

  assert.equal(result.intent, "ROLE_OR_ACCESS_QUESTION");
  assert.ok(result.confidence >= 0.9);
});

test("deterministic business classification downgrades overlapping health phrasing to semantic follow-up", () => {
  const result = classifyAiIntent("I think Ridely is in bad shape");

  assert.equal(result.intent, "UNKNOWN");
  assert.ok((result.capabilityCandidates?.length ?? 0) > 0);
});

test("treats broad entity briefing prompts as scoped business follow-ups", () => {
  const result = classifyAiIntent("Tell me about Ridely.");

  assert.equal(result.intent, "UNKNOWN");
  assert.equal(result.preferredScopeKind, "project");
  assert.ok((result.capabilityCandidates?.length ?? 0) > 0);
});

test("classifies overloaded questions without relying on one fixed phrase", () => {
  const result = classifyAiIntent("who needs help right now?");

  assert.equal(result.intent, "WHO_IS_OVERLOADED");
});

test("hybrid classifier accepts model-primary multilingual business classification", async () => {
  const result = await classifyAiIntentHybrid("Ridely app ki current health kaisi hai?", {
    allowModel: true,
    modelClassifier: async () => ({
      intent: "PROJECT_REPORT",
      confidence: 0.91,
      reason: "Multilingual project health question.",
      preferredScopeKind: "project",
    }),
  });

  assert.equal(result.intent, "PROJECT_REPORT");
  assert.equal(result.source, "model");
  assert.equal(result.preferredScopeKind, "project");
});

test("hybrid classifier accepts non-English workspace-summary phrasing semantically", async () => {
  const result = await classifyAiIntentHybrid("workspace ki overall halat batao", {
    allowModel: true,
    modelClassifier: async () => ({
      intent: "WORKSPACE_SUMMARY",
      confidence: 0.9,
      reason: "Mixed-language workspace health summary request.",
      preferredScopeKind: "workspace",
    }),
  });

  assert.equal(result.intent, "WORKSPACE_SUMMARY");
  assert.equal(result.source, "model");
});

test("hybrid classifier accepts alternate project-risk phrasing semantically", async () => {
  const result = await classifyAiIntentHybrid("Ridely lag raha hai ke risk mein hai", {
    allowModel: true,
    modelClassifier: async () => ({
      intent: "PROJECT_RISK",
      confidence: 0.88,
      reason: "Project risk phrasing in mixed language.",
      preferredScopeKind: "project",
    }),
  });

  assert.equal(result.intent, "PROJECT_RISK");
  assert.equal(result.source, "model");
});

test("hybrid classifier falls back deterministically when model classification fails", async () => {
  const result = await classifyAiIntentHybrid("who is overloaded in the workspace", {
    allowModel: true,
    modelClassifier: async () => {
      throw new Error("classifier unavailable");
    },
  });

  assert.equal(result.intent, "WHO_IS_OVERLOADED");
  assert.equal(result.source, "fallback");
});

test("classifies my tasks and navigation help deterministically", () => {
  assert.equal(classifyAiIntent("show my tasks").intent, "MY_TASKS");
  assert.equal(classifyAiIntent("where can i find projects").intent, "APP_NAVIGATION_HELP");
});

test("classifies mixed-language overdue request semantically", () => {
  const result = classifyAiIntent("mere overdue tasks dikhao");
  assert.equal(result.intent, "OVERDUE_TASKS");
});
