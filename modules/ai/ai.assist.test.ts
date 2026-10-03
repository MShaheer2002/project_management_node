import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../../config/env.js";
import { prisma } from "../../shared/utils/prisma.js";
import { assist } from "./ai.assist.js";

// Billing enforced on a Free workspace: the help assistant must still answer.
(env as { AI_ENFORCE_BILLING: boolean }).AI_ENFORCE_BILLING = true;
prisma.subscription.findUnique = (async () => ({ plan: "FREE", status: "ACTIVE" })) as never;
prisma.aiWorkspaceUsageDaily.findUnique = (async () => null) as never;
prisma.aiUserUsageDaily.findUnique = (async () => null) as never;
// Conversation memory: capture what gets saved instead of writing to a database.
const saved: unknown[] = [];
prisma.aiAssistMessage.createMany = (async (args: { data: unknown[] }) => { saved.push(...args.data); return { count: args.data.length }; }) as never;
prisma.aiAssistMessage.findMany = (async () => []) as never;
prisma.aiAssistMessage.deleteMany = (async () => ({ count: 0 })) as never;
prisma.aiAssistAnswer.create = (async () => ({ id: "answer-1" })) as never;

const ask = (message: string, route: string) =>
  assist({ message, route, workspaceId: "ws", userId: "u", userRole: "OWNER" } as never);

test("'which page am I on' is answered from the page, without a model call", async () => {
  const pages: Array<[string, string]> = [
    ["/inbox", "Inbox"],
    ["/ai-usage", "AI Usage"],
    ["/templates/abc/edit", "Edit Template"],
    ["/issues/ACME-12", "Issue Detail"],
  ];
  for (const [route, label] of pages) {
    const reply = await ask("on which scren i am on?", route);
    assert.equal(reply.usage.model, "local", route);
    assert.match(reply.answer, new RegExp(`You are on \\*\\*${label}\\*\\*`), route);
  }
});

test("an unknown page says so instead of guessing", async () => {
  const reply = await ask("what page is this", "/not-a-page");
  assert.equal(reply.usage.model, "local");
  assert.match(reply.answer, /can't tell which page/);
});

test("API key questions point to AI Connections, a page that exists", async () => {
  const reply = await ask("where are api keys", "/dashboard");
  assert.equal(reply.navigation?.route, "/ai-connections");
});

test("every answer is saved to the conversation, question first", async () => {
  saved.length = 0;
  await ask("which page am I on", "/inbox");
  assert.equal(saved.length, 2);
  const [question, answer] = saved as Array<{ role: string; content: string; payload?: { title?: string } }>;
  assert.equal(question!.role, "user");
  assert.equal(question!.content, "which page am I on");
  assert.equal(answer!.role, "assistant");
  assert.match(answer!.content, /You are on \*\*Inbox\*\*/);
  assert.equal(answer!.payload?.title, "Inbox");
});

test("instant answers link to the help article they come from", async () => {
  const page = await ask("which page am I on", "/billing");
  assert.deepEqual(page.sources, [{ articleId: "billing-and-payments", title: "Billing and payments" }]);

  const role = await ask("what is my role", "/dashboard");
  assert.match(role.answer, /Owner/);
  assert.match(role.answer, /billing, deleting the workspace/, "role text comes from the Roles and permissions article");
  assert.deepEqual(role.sources?.map((s) => s.articleId), ["roles-and-permissions"]);

  const nav = await ask("where are api keys", "/dashboard");
  assert.deepEqual(nav.sources?.map((s) => s.articleId), ["ai-connections"]);
});
