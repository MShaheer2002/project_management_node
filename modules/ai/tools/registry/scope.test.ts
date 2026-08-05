import assert from "node:assert/strict";
import { test } from "node:test";

import { createRegistryExecutor, getToolsForSurface, selectToolsForTurn } from "./index.js";
import { isOutOfScopeError, TOOL_NOT_IN_SCOPE } from "./scope.js";

const allTools = getToolsForSurface("panel");
const ctx = { workspaceId: "ws-1", userId: "u-1", userRole: "OWNER" };
const names = (text: string) => new Set(selectToolsForTurn(allTools, text).tools.map((t) => t.name));

test("core issue and clarification tools are always offered", () => {
  // Including for input with no domain signal at all.
  for (const text of ["hello", "yes", "thanks", ""]) {
    const offered = names(text);
    assert.ok(offered.has("issues_search"), `issues_search missing for: ${text}`);
    assert.ok(offered.has("issues_update"), `issues_update missing for: ${text}`);
    assert.ok(
      offered.has("ask_user_to_clarify"),
      `ask_user_to_clarify missing for "${text}" — losing it pushes the model back to guessing`,
    );
  }
});

test("scoping meaningfully reduces the offered toolset", () => {
  const scope = selectToolsForTurn(allTools, "tell me about my issues that are active");
  assert.ok(
    scope.tools.length < allTools.length / 2,
    `expected well under ${allTools.length} tools, got ${scope.tools.length}`,
  );
  assert.equal(scope.isFullToolset, false);
});

test("domain signals pull in the tools that request actually needs", () => {
  const cases: Array<[string, string]> = [
    ["who is most stressed as a team", "analytics_report"],
    ["how is the mobile project doing", "analytics_report"],
    ["is Ridely on track", "analytics_report"],
    ["create a project for the mobile team", "projects_create"],
    ["add Sara to the backend team", "members_manage"],
    ["what documents do we have", "documents_search"],
    ["show me the roadmap", "roadmap_get"],
    ["how is the current sprint going", "cycles_search"],
    ["list our templates", "templates_search"],
    ["any unread notifications", "notifications_manage"],
    ["is github connected", "integrations_get"],
    ["invite ahmed@example.com", "workspace_invitations"],
  ];

  for (const [text, expected] of cases) {
    assert.ok(names(text).has(expected), `"${text}" should offer ${expected}`);
  }
});

test("indirect performance phrasing still reaches analytics", () => {
  // The exact class of phrasing that broke under keyword intent routing: no
  // metric named, no scope named.
  for (const text of ["who is drowning", "how are we doing", "who needs help", "is anyone overloaded"]) {
    assert.ok(names(text).has("analytics_report"), `"${text}" should offer analytics`);
  }
});

test("scoping reads the whole conversation, not just the last message", () => {
  // A bare follow-up carries no signal on its own; the prior turn supplies it.
  const followUpAlone = names("do that for them too");
  const withContext = names("how is the backend team doing\ndo that for them too");

  assert.ok(!followUpAlone.has("teams_search"), "no team signal in the follow-up alone");
  assert.ok(withContext.has("teams_search"), "team domain should carry over from earlier context");
});

test("a broad request falls back to the full toolset", () => {
  const scope = selectToolsForTurn(
    allTools,
    "give me a full workspace report on projects, teams, departments, cycles, documents, roadmap, " +
      "templates, notifications, api keys, labels and members",
  );
  assert.equal(scope.isFullToolset, true, "near-total scope should skip the expansion path entirely");
  assert.equal(scope.tools.length, allTools.length);
});

// ─── Escape hatch ───────────────────────────────────────────────────────────

test("a scoped-out tool reports as out-of-scope, not as nonexistent", async () => {
  const offered = new Set(["issues_search"]);
  const execute = createRegistryExecutor("panel", offered);

  const result = await execute("roadmap_get", {}, ctx);

  assert.equal(result.success, false);
  assert.ok(isOutOfScopeError(result.error), "must be recoverable, not reported as unknown");
  assert.match(result.error ?? "", new RegExp(TOOL_NOT_IN_SCOPE));
});

test("a genuinely unknown tool is not treated as recoverable", async () => {
  const execute = createRegistryExecutor("panel", new Set(["issues_search"]));

  const result = await execute("issues_teleport", {}, ctx);

  assert.equal(result.success, false);
  assert.equal(isOutOfScopeError(result.error), false, "hallucinated tools must not trigger expansion");
});

test("surface limits still apply regardless of scoping", async () => {
  // Passing a write tool as "offered" must not let the background surface call it.
  const execute = createRegistryExecutor("background", new Set(["issues_update"]));

  const result = await execute("issues_update", { issueId: "TRU-1" }, ctx);

  assert.equal(result.success, false);
  assert.equal(isOutOfScopeError(result.error), false, "a surface boundary is not a scoping miss");
  assert.match(result.error ?? "", /unknown or unavailable/i);
});

test("no scoping means every permitted tool stays callable", async () => {
  const execute = createRegistryExecutor("panel");
  const result = await execute("roadmap_get", {}, ctx);

  // Reaches the handler (and fails there or succeeds), rather than being blocked.
  assert.equal(isOutOfScopeError(result.error), false);
});
