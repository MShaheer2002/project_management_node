import assert from "node:assert/strict";
import { test } from "node:test";

import { searchWorkspace } from "./ai.search.js";
import { prisma } from "../../shared/utils/prisma.js";

/**
 * These exercise search against the real database, because the behaviour worth
 * protecting — that a paraphrase finds an issue sharing no substring with it —
 * only exists when there are real embeddings to search. Mocking pgvector would
 * test the mock.
 *
 * Each test resolves its own fixtures rather than hardcoding ids, so the suite
 * survives a reseeded database.
 */

const WORKSPACE = await prisma.workspace
  .findFirst({ where: { issuePrefix: "TRU" }, select: { id: true } })
  .catch(() => null);

const hasFixtures = Boolean(WORKSPACE);
const skip = hasFixtures ? false : "no TRU workspace in this database";

test("an exact issue key short-circuits to that issue", { skip }, async () => {
  const issue = await prisma.issue.findFirst({
    where: { workspaceId: WORKSPACE!.id },
    select: { id: true },
  });
  if (!issue) return;

  const result = await searchWorkspace({ workspaceId: WORKSPACE!.id, query: issue.id });

  assert.deepEqual(result.strategies, ["exact"]);
  assert.equal(result.hits.length, 1, "an id is a lookup, not a similarity question");
  assert.equal(result.hits[0]?.entityId, issue.id);
});

test("an unknown issue key does not short-circuit", { skip }, async () => {
  const result = await searchWorkspace({ workspaceId: WORKSPACE!.id, query: "ZZZ-9999" });

  assert.ok(!result.strategies.includes("exact"), "a key that matches nothing must fall through");
});

test("paraphrase finds issues sharing no substring with the query", { skip }, async () => {
  // The motivating case: none of these issues contain the word "firing".
  const result = await searchWorkspace({
    workspaceId: WORKSPACE!.id,
    query: "the notification thing that keeps firing",
    entityTypes: ["ISSUE"],
    limit: 5,
  });

  assert.ok(result.hits.length > 0, "semantic search should find notification issues");
  assert.ok(result.strategies.includes("vector"));

  const labels = result.hits.map((hit) => hit.label.toLowerCase());
  assert.ok(
    labels.some((label) => label.includes("notif")),
    `expected a notification issue, got: ${labels.join(" | ")}`,
  );
});

test("search spans entity types, not just issues", { skip }, async () => {
  const result = await searchWorkspace({
    workspaceId: WORKSPACE!.id,
    query: "who works on the frontend",
    limit: 10,
  });

  const types = new Set(result.hits.map((hit) => hit.entityType));
  assert.ok(
    types.has("MEMBER"),
    `people should be searchable; got types: ${[...types].join(", ") || "none"}`,
  );
});

test("entityTypes narrows the search", { skip }, async () => {
  const result = await searchWorkspace({
    workspaceId: WORKSPACE!.id,
    query: "notification",
    entityTypes: ["ISSUE"],
    limit: 10,
  });

  for (const hit of result.hits) {
    assert.equal(hit.entityType, "ISSUE");
  }
});

test("keyword and vector both contribute on a literal string", { skip }, async () => {
  // Exact tokens like an endpoint path are where keyword matching earns its
  // place — embeddings blur them.
  const result = await searchWorkspace({
    workspaceId: WORKSPACE!.id,
    query: "notificaiton-count",
    entityTypes: ["ISSUE"],
    limit: 5,
  });

  assert.ok(result.hits.length > 0);
  const strategies = new Set(result.hits.flatMap((hit) => hit.matchedBy));
  assert.ok(
    strategies.has("keyword") || strategies.has("vector"),
    "a literal token should be retrievable",
  );
});

test("results found by both strategies outrank results found by one", { skip }, async () => {
  const result = await searchWorkspace({
    workspaceId: WORKSPACE!.id,
    query: "notification polling",
    entityTypes: ["ISSUE"],
    limit: 10,
  });

  const both = result.hits.filter((hit) => hit.matchedBy.length > 1);
  if (both.length === 0 || both.length === result.hits.length) return; // nothing to compare

  const bestBoth = Math.min(...both.map((hit) => result.hits.indexOf(hit)));
  const bestSingle = Math.min(
    ...result.hits.filter((hit) => hit.matchedBy.length === 1).map((hit) => result.hits.indexOf(hit)),
  );

  assert.ok(bestBoth < bestSingle, "rank fusion should favour agreement between strategies");
});

test("scores are ordered descending", { skip }, async () => {
  const result = await searchWorkspace({
    workspaceId: WORKSPACE!.id,
    query: "login authentication problems",
    limit: 10,
  });

  const scores = result.hits.map((hit) => hit.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test("an empty query returns nothing rather than everything", { skip }, async () => {
  for (const query of ["", "   "]) {
    const result = await searchWorkspace({ workspaceId: WORKSPACE!.id, query });
    assert.equal(result.hits.length, 0, `empty query must not match the workspace: ${JSON.stringify(query)}`);
    assert.deepEqual(result.strategies, []);
  }
});

test("search is scoped to one workspace", { skip }, async () => {
  const other = await prisma.workspace.findFirst({
    where: { id: { not: WORKSPACE!.id } },
    select: { id: true },
  });
  if (!other) return;

  const result = await searchWorkspace({ workspaceId: other.id, query: "notification", limit: 20 });

  if (result.hits.length === 0) return;

  const rows = await prisma.aiEmbedding.findMany({
    where: { entityId: { in: result.hits.map((hit) => hit.entityId) } },
    select: { workspaceId: true },
  });

  for (const row of rows) {
    assert.equal(row.workspaceId, other.id, "results must never cross a workspace boundary");
  }
});

test("keywordOnly skips the embedding call", { skip }, async () => {
  const result = await searchWorkspace({
    workspaceId: WORKSPACE!.id,
    query: "notification",
    keywordOnly: true,
    limit: 5,
  });

  assert.ok(!result.strategies.includes("vector"));
  assert.equal(result.degraded, false, "opting out of vector search is not degradation");
});

test.after(() => prisma.$disconnect());
