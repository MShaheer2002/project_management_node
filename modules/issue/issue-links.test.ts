import test from "node:test";
import assert from "node:assert/strict";
import { mergeIntegrationRef } from "./issue.service.js";
import { updateIntegrationRefSchema } from "./issue.schemas.js";
import { executeTool } from "../ai/tools/tool-executor.js";

const pr = { id: "a", provider: "github", label: "PR 12", externalId: null, url: "https://github.com/acme/app/pull/12" };
const slack = { id: "b", provider: "slack", label: null, externalId: "C1/p1", url: null };
const figma = (url: string | null) => ({ provider: "figma", label: null, externalId: null, url });

test("adding a link keeps every existing link (F-46)", () => {
  const next = mergeIntegrationRef([pr, slack], figma("https://figma.com/file/x"));
  assert.equal(next.length, 3);
  assert.deepEqual(next.slice(0, 2), [pr, slack]);
  assert.ok(next[2]!.id && next[2]!.id !== "a" && next[2]!.id !== "b", "new link gets its own id");
});

test("the same URL, or same provider and external id, updates instead of duplicating", () => {
  const byUrl = mergeIntegrationRef([pr, slack], { ...pr, label: "PR 12 merged" });
  assert.deepEqual(byUrl.map((r) => r.label), ["PR 12 merged", null]);
  assert.equal(byUrl[0]!.id, "a", "keeps its id");
  const byExternalId = mergeIntegrationRef([pr, slack], { provider: "slack", label: "Thread", externalId: "C1/p1", url: null });
  assert.equal(byExternalId.length, 2);
  assert.equal(byExternalId[1]!.label, "Thread");
});

test("an issue can't go past 25 links", () => {
  const full = Array.from({ length: 25 }, (_, i) => ({ ...pr, id: `r${i}`, url: `https://x.test/${i}` }));
  assert.throws(() => mergeIntegrationRef(full, figma("https://figma.com/new")), /at most 25/);
  assert.equal(mergeIntegrationRef(full, { ...pr, url: "https://x.test/3", label: "edited" }).length, 25, "editing one still works");
});

test("the app only saves http and https links", () => {
  const parse = (url: string) => updateIntegrationRefSchema.body.safeParse({ integrationRefs: [{ id: "a", provider: "custom", url }] }).success;
  assert.equal(parse("https://example.com"), true);
  assert.equal(parse("http://example.com"), true);
  for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>", "vbscript:x", "file:///etc/passwd"]) {
    assert.equal(parse(bad), false, bad);
  }
});

test("the AI tool refuses bad links and unknown providers before touching the issue", async () => {
  const ctx = { workspaceId: "ws", userId: "u1", userRole: "MEMBER" } as never;
  const bad = await executeTool("update_issue_integration_ref", { issueId: "W-1", provider: "custom", url: "javascript:alert(1)" }, ctx);
  assert.equal(bad.success, false);
  assert.match(bad.error!, /http or https/);
  const unknown = await executeTool("update_issue_integration_ref", { issueId: "W-1", provider: "discord", url: "https://x.test" }, ctx);
  assert.equal(unknown.success, false);
  assert.match(unknown.error!, /provider must be one of/);
});

test("errors inside AI write tools come back as a failed result, not a crash", async () => {
  const { prisma } = await import("../../shared/utils/prisma.js");
  const db = prisma as any;
  const full = Array.from({ length: 25 }, (_, i) => ({ ...pr, id: `r${i}`, url: `https://x.test/${i}` }));
  const saved: unknown[] = [];
  db.issue.findFirst = async () => ({ id: "W-1", title: "t", cycleId: null, projectId: "p", integrationRef: full });
  db.issue.findUnique = db.issue.findFirst;
  db.issue.update = async (args: unknown) => { saved.push(args); return {}; };
  db.project.findFirst = async () => ({ id: "p" });
  db.aiToolExecution = { findFirst: async () => null, create: async () => ({ id: "e" }), update: async () => ({}), delete: async () => ({}) };

  const result = await executeTool("update_issue_integration_ref", { issueId: "W-1", provider: "custom", url: "https://x.test/new" },
    { workspaceId: "ws", userId: "u1", userRole: "OWNER" } as never);
  assert.equal(result.success, false);
  assert.match(result.error!, /at most 25/);
  assert.equal(saved.length, 0);
});
