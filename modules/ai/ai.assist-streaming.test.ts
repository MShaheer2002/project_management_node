/**
 * End to end: AI Assistance streaming against a fake OpenRouter (local HTTP
 * server), so the real provider code, parser and grounding gate all run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

let reply = "";
let failWith: number | null = null;
let bytesSent = 0;
let lastCompletionAborted = false;

const server: Server = createServer((req, res) => {
  if (req.url?.endsWith("/embeddings")) {
    res.writeHead(500).end("{}"); // meaning search off: keyword only
    return;
  }
  if (failWith) {
    res.writeHead(failWith, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "boom" } }));
    return;
  }
  lastCompletionAborted = false;
  res.on("close", () => { if (!res.writableEnded) lastCompletionAborted = true; });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const pieces = reply.match(/[\s\S]{1,7}/g) ?? [];
  let i = 0;
  const tick = () => {
    if (res.destroyed) return;
    if (i < pieces.length) {
      const line = `data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] })}\n\n`;
      bytesSent += line.length;
      res.write(line);
      setTimeout(tick, 2);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    }
  };
  tick();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.OPENROUTER_API_KEY = "test-key";

const { prisma } = await import("../../shared/utils/prisma.js");
const { assist } = await import("./ai.assist.js");
type Event = { type: string; data: any };

const p = prisma as any;
p.subscription.findUnique = async () => ({ plan: "FREE", status: "ACTIVE", storageUsedBytes: 0 });
p.aiWorkspaceUsageDaily.findUnique = async () => null;
p.aiUserUsageDaily.findUnique = async () => null;
p.aiAssistMessage.createMany = async () => ({ count: 2 });
p.aiAssistMessage.findMany = async () => [];
p.aiAssistMessage.deleteMany = async () => ({ count: 0 });
p.aiAssistAnswer.create = async () => ({ id: "answer-1" });
p.workspaceMembership.count = async () => 3;
p.workspaceInvitation.count = async () => 0;
p.integration.findMany = async () => [];
p.userDriveConnection.findUnique = async () => null;
// Called as a tagged template or with a Prisma.sql object; keyword search is the query that ranks with ts_rank.
p.$queryRaw = async (first: TemplateStringsArray | { strings: string[] }) =>
  (Array.isArray(first) ? first : (first as { strings: string[] }).strings).join("").includes("ts_rank(")
    ? [{ id: "members-and-invites#1", articleId: "members-and-invites", sectionTitle: "Invite people", content: "Article: Members\n\nOwners and admins invite people from Members." }]
    : [];

async function run(question = "how do I invite a teammate to the workspace", signal?: AbortSignal) {
  const events: Event[] = [];
  let thrown: unknown;
  try {
    await assist(
      { message: question, route: "/members", workspaceId: "ws", userId: "u", userRole: "ADMIN" } as never,
      { emit: (event) => events.push(event), ...(signal ? { signal } : {}) },
    );
  } catch (error) {
    thrown = error;
  }
  return { events, types: events.map((e) => e.type), done: events.find((e) => e.type === "done")?.data, thrown };
}

const header = (h: object) => JSON.stringify(h);

test("a grounded answer streams: status, meta with sources, text pieces, then the complete answer", async () => {
  failWith = null;
  reply = `${header({ basis: "help", sources: [1], confidence: "high", intent: "feature", title: "Invite people" })}\n@@ANSWER@@\n1. Open **Members**.\n2. Click **Invite**.\n@@END@@\n{"followUps":["Who can invite?"],"navigation":{"route":"/members","label":"Open Members"}}`;
  const { events, types, done } = await run();
  assert.deepEqual(types.slice(0, 3), ["status", "status", "meta"]);
  assert.deepEqual(events.find((e) => e.type === "meta")!.data.sources, [{ articleId: "members-and-invites", title: "Members and invitations" }]);
  const streamed = events.filter((e) => e.type === "delta").map((e) => e.data.text).join("");
  assert.ok(types.filter((t) => t === "delta").length > 1, "the answer arrives in pieces");
  assert.equal(streamed.trim(), "1. Open **Members**.\n2. Click **Invite**.");
  assert.ok(!streamed.includes("@@"));
  assert.equal(types.at(-1), "done");
  assert.equal(done.answer, "1. Open **Members**.\n2. Click **Invite**.");
  assert.equal(done.grounded, true);
  assert.deepEqual(done.followUps, ["Who can invite?"]);
  assert.equal(done.navigation.route, "/members");
  assert.equal(done.usage.totalTokens, 150);
  assert.equal(done.answerId, "answer-1", "every answer can be rated");
});

test("an ungrounded header stops the model and shows nothing but 'not sure'", async () => {
  failWith = null;
  reply = `${header({ basis: "none", sources: [], confidence: "low" })}\n@@ANSWER@@\n${"Made up text. ".repeat(200)}\n@@END@@\n{}`;
  bytesSent = 0;
  const { types, done } = await run();
  assert.ok(!types.includes("meta") && !types.includes("delta"), "no unchecked text is ever sent");
  assert.equal(done.grounded, false);
  assert.match(done.answer, /not sure/);
  assert.equal(done.support.email, "support@trussen.app");
  assert.deepEqual(done.sources.map((s: { articleId: string }) => s.articleId), ["members-and-invites"]);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastCompletionAborted, "the model call was cut off");
  assert.ok(bytesSent < 2_000, `stopped early (sent ${bytesSent} bytes of ~${reply.length * 3})`);
});

test("citing a source it wasn't given doesn't count", async () => {
  failWith = null;
  reply = `${header({ basis: "help", sources: [7], confidence: "high" })}\n@@ANSWER@@\nTrust me.\n@@END@@\n{}`;
  const { types, done } = await run();
  assert.ok(!types.includes("delta"));
  assert.equal(done.grounded, false);
});

test("a reply in the old JSON format still works, unstreamed", async () => {
  failWith = null;
  reply = JSON.stringify({ intent: "feature", answer: "Open Members and click Invite.", basis: "help", sources: [1], confidence: "high" });
  const { types, done } = await run();
  assert.ok(!types.includes("delta"));
  assert.equal(done.answer, "Open Members and click Invite.");
  assert.equal(done.grounded, true);
});

test("when the provider fails, the answer is links to matching articles, not an error", async () => {
  failWith = 500;
  const { done, thrown } = await run();
  assert.equal(thrown, undefined);
  assert.equal(done.grounded, false);
  assert.match(done.answer, /can't write an answer right now/);
  assert.equal(done.sources[0].articleId, "members-and-invites");
});

test("closing the bubble mid-answer stops quietly: no answer, nothing saved", async () => {
  failWith = null;
  reply = `${header({ basis: "help", sources: [1], confidence: "high" })}\n@@ANSWER@@\n${"Step. ".repeat(500)}\n@@END@@\n{}`;
  let saves = 0;
  p.aiAssistMessage.createMany = async () => { saves++; return { count: 2 }; };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  const { types, thrown } = await run(undefined, controller.signal);
  assert.equal((thrown as Error)?.name, "AiCallAbortedError");
  assert.ok(!types.includes("done"));
  assert.equal(saves, 0);
});

test("instant answers send a single done event", async () => {
  const { types } = await run("which page am I on");
  assert.deepEqual(types, ["done"]);
});

test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
