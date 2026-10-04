import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FREE_PLAN_MEMBER_CAP, FREE_PLAN_TEAM_CAP } from "../billing/billing.service.js";
import { buildHelpFacts, loadHelpArticles, parseHelpArticle } from "./help.content.js";
import { getHelpArticle, helpArticlesFor, listHelpArticles } from "./help.service.js";

const facts = buildHelpFacts();

// Every in-app page (project_management_react/src/app/routes.tsx). An article's
// route must be one of these, or the "Open page" link would lead nowhere.
const APP_ROUTES = new Set([
  "/dashboard", "/inbox", "/issues", "/issues/my", "/issues/create", "/issues/:id",
  "/projects", "/projects/:id", "/teams", "/teams/:id", "/departments", "/departments/:id",
  "/cycles", "/cycles/:id", "/roadmap", "/activity", "/analytics", "/integrations",
  "/templates", "/members", "/billing", "/ai-usage", "/ai-connections", "/settings",
  "/login", "/invite",
]);

const article = (meta: string, body = "Some help.") => `---\n${meta}\n---\n${body}\n`;
const GOOD_META = "id: sample\ntitle: Sample\ncategory: Issues\nroles: OWNER, MEMBER\nplans: FREE\nkeywords: sample";

test("every real article loads, with unique ids and every placeholder filled", () => {
  const articles = loadHelpArticles();
  assert.ok(articles.length >= 40, `expected at least 40 articles, got ${articles.length}`);
  assert.equal(new Set(articles.map((a) => a.id)).size, articles.length);
  for (const a of articles) {
    assert.ok(!a.body.includes("{{"), `${a.id} has an unfilled placeholder`);
    assert.ok(a.summary.length > 0, `${a.id} has no summary paragraph`);
    if (a.route) assert.ok(APP_ROUTES.has(a.route), `${a.id} points to unknown page ${a.route}`);
    // UI copy rule: short and simple, no dashes.
    assert.ok(!/[—–]/.test(a.body), `${a.id} uses a dash`);
  }
});

test("documented limits come from the code that enforces them", () => {
  assert.equal(facts["free.memberCap"], String(FREE_PLAN_MEMBER_CAP));
  assert.equal(facts["free.teamCap"], String(FREE_PLAN_TEAM_CAP));
  const plans = loadHelpArticles().find((a) => a.id === "plans-and-limits")!;
  assert.match(plans.body, new RegExp(`\\| Members \\| ${FREE_PLAN_MEMBER_CAP} `));
});

test("a broken article is rejected with a clear reason", () => {
  const bad: Array<[string, RegExp]> = [
    ["no front matter here", /missing front matter/],
    [article(GOOD_META.replace("roles: OWNER, MEMBER", "roles: SUPERUSER")), /roles/],
    [article(GOOD_META.replace("category: Issues", "category: Misc")), /category/],
    [article(GOOD_META.replace("id: sample", "id: other")), /must match the file name/],
    [article(`${GOOD_META}\ntitle: Again`), /duplicate front matter key/],
    [article(GOOD_META, "Limit is {{free.nope}}."), /unknown placeholder/],
    [article(GOOD_META, ""), /empty article/],
    [article(GOOD_META.replace("keywords: sample", "")), /keywords/],
  ];
  for (const [source, reason] of bad) {
    assert.throws(() => parseHelpArticle(source, "sample.md", facts), reason);
  }
  assert.equal(parseHelpArticle(article(GOOD_META, "Members: {{free.memberCap}}."), "sample.md", facts).body, `Members: ${FREE_PLAN_MEMBER_CAP}.`);
});

test("a folder of articles loads, and an empty folder fails startup", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "help-"));
  writeFileSync(path.join(dir, "sample.md"), article(GOOD_META));
  assert.equal(loadHelpArticles(dir).length, 1);
  assert.throws(() => loadHelpArticles(mkdtempSync(path.join(tmpdir(), "empty-"))), /No help articles/);
});

test("articles are filtered by role; a hidden article is a plain 404", () => {
  const member = { role: "MEMBER", plan: "FREE" } as const;
  const owner = { role: "OWNER", plan: "FREE" } as const;
  const memberIds = listHelpArticles(member).articles.map((a) => a.id);
  assert.ok(!memberIds.includes("billing-and-payments"));
  assert.ok(!memberIds.includes("delete-and-restore-workspace"));
  assert.ok(listHelpArticles(owner).articles.some((a) => a.id === "billing-and-payments"));
  assert.throws(() => getHelpArticle("billing-and-payments", member), /not found/);
  assert.throws(() => getHelpArticle("does-not-exist", member), /not found/);
  assert.ok(helpArticlesFor(member).every((a) => a.roles.includes("MEMBER")));
});

test("plans don't hide articles, they mark them", () => {
  const free = listHelpArticles({ role: "MEMBER", plan: "FREE" });
  const premium = listHelpArticles({ role: "MEMBER", plan: "PREMIUM" });
  assert.equal(free.articles.find((a) => a.id === "trussen-ai")?.onYourPlan, false);
  assert.equal(premium.articles.find((a) => a.id === "trussen-ai")?.onYourPlan, true);
  assert.equal(free.categories[0], "Getting started");
});

test("every role has a row in the Roles and permissions article", async () => {
  const { roleSummaryFromArticle } = await import("./help.service.js");
  for (const role of ["OWNER", "ADMIN", "MEMBER", "GUEST"] as const) {
    assert.ok((roleSummaryFromArticle(role) ?? "").length > 20, `${role} row missing`);
  }
});

test("every page has exactly one main article, and the page article respects role", async () => {
  const { helpPageArticle } = await import("./help.service.js");
  assert.equal(helpPageArticle("/issues/ACME-1", { role: "MEMBER", plan: "FREE" })?.id, "issue-detail");
  assert.equal(helpPageArticle("/issues/my", { role: "MEMBER", plan: "FREE" })?.id, "my-issues", "exact page beats /issues/:id");
  assert.equal(helpPageArticle("/issues/create", { role: "MEMBER", plan: "FREE" })?.id, "create-issue");
  assert.equal(helpPageArticle("/billing", { role: "OWNER", plan: "FREE" })?.id, "billing-and-payments");
  assert.equal(helpPageArticle("/billing", { role: "MEMBER", plan: "FREE" })?.id, "plans-and-limits", "falls back to an article the member can read");
  assert.equal(helpPageArticle("/nowhere", { role: "OWNER", plan: "FREE" }), null);

  const two = `---\nid: sample\ntitle: S\ncategory: Issues\nroute: /issues\nprimary: true\nroles: OWNER\nplans: FREE\nkeywords: s\n---\nText.\n`;
  const dir = mkdtempSync(path.join(tmpdir(), "help-primary-"));
  writeFileSync(path.join(dir, "sample.md"), two);
  writeFileSync(path.join(dir, "other.md"), two.replace("id: sample", "id: other"));
  assert.throws(() => loadHelpArticles(dir), /exactly one article with "primary: true", found sample, other|found other, sample/);
});
