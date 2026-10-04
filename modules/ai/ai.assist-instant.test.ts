import test from "node:test";
import assert from "node:assert/strict";
import { GUIDE_ROUTES, matchInstantRequest, normalizeQuestion } from "./ai.assist-instant.js";
import { normalizeAiResponse } from "./ai.assist.js";

const kind = (question: string) => matchInstantRequest(question)?.kind ?? null;
const routeOf = (question: string) => {
  const match = matchInstantRequest(question);
  return match?.kind === "navigate" ? match.route.route : null;
};

test("questions are normalized: case, punctuation, curly quotes, politeness", () => {
  assert.equal(normalizeQuestion("  Can you PLEASE take me to Billing?!  "), "take me to billing");
  assert.equal(normalizeQuestion("Where’s the inbox, thanks"), "where's the inbox");
  assert.equal(normalizeQuestion("???"), "");
});

test("a pure navigation request goes straight to the page", () => {
  const cases: Array<[string, string]> = [
    ["take me to billing", "/billing"],
    ["Open settings", "/settings"],
    ["show me the roadmap", "/roadmap"],
    ["where are api keys", "/ai-connections"],
    ["where is the help center", "/help"],
    ["where are my notifications", "/inbox"],
    ["where are my assigned issues", "/issues/my"],
    ["go to the billing page", "/billing"],
    ["how do I get to analytics?", "/analytics"],
    ["billing", "/billing"],
    ["could you open my issues for me", "/issues/my"],
  ];
  for (const [question, route] of cases) assert.equal(routeOf(question), route, question);
});

test("a question that only mentions a page is not a navigation request", () => {
  const questions = [
    "where do I upload project documents",
    "where can I see team velocity",
    "where do I get a figma access token",
    "which project do issues created from slack go to",
    "how much does premium cost",
    "how do I open an issue from a template",
    "show me how to invite members to a team",
    "open issues older than a week",
    "where are notifications for mentions configured",
    "can I change billing details as an admin",
    "billing کہاں ہے", // other scripts keep their words, so this isn't reduced to "billing"
  ];
  for (const question of questions) assert.equal(kind(question), null, question);
});

test("role, page and assigned questions are recognised only when that is the whole question", () => {
  for (const q of ["what is my role", "What's my role?", "what can I do here", "what permissions do I have", "which role am I"]) {
    assert.equal(kind(q), "role", q);
  }
  for (const q of ["which page am I on", "on which scren i am on?", "where am I", "what is this page for", "how does this page work"]) {
    assert.equal(kind(q), "current-page", q);
  }
  for (const q of ["how many issues are assigned to me", "how many open tasks do I have", "what are my issues"]) {
    assert.equal(kind(q), "assigned", q);
  }
  for (const q of ["hi", "Hello!", "good morning"]) assert.equal(kind(q), "greeting", q);

  for (const q of [
    "how do I change a member's permissions",
    "what can I do if an invite expired",
    "how do I export this page",
    "how do I filter my issues by priority",
    "hi, how do I create a cycle",
  ]) {
    assert.equal(kind(q), null, q);
  }
});

test("every page name points to exactly one page", () => {
  const seen = new Map<string, string>();
  for (const route of GUIDE_ROUTES) {
    for (const name of route.names) {
      assert.equal(name, normalizeQuestion(name), `${name} must be stored normalized`);
      assert.ok(!seen.has(name), `${name} is used by ${seen.get(name)} and ${route.route}`);
      seen.set(name, route.route);
    }
  }
});

test("a model answer keeps its text when its button leads somewhere the person can't go", () => {
  const reply = {
    intent: "feature",
    title: "Premium price",
    answer: "Premium is $10 per member per month.",
    followUps: [],
    facts: [],
    navigation: { route: "/billing", label: "Open Billing" },
  };

  const member = normalizeAiResponse(reply, "MEMBER");
  assert.equal(member?.answer, "Premium is $10 per member per month.");
  assert.equal(member?.title, "Premium price");
  assert.equal(member?.navigation, undefined);

  assert.deepEqual(normalizeAiResponse(reply, "OWNER")?.navigation, { route: "/billing", label: "Open Billing" });

  const invented = normalizeAiResponse({ ...reply, navigation: { route: "/secret", label: "Open" } }, "OWNER");
  assert.equal(invented?.answer, reply.answer);
  assert.equal(invented?.navigation, undefined);
});
