import test from "node:test";
import assert from "node:assert/strict";
import type { HelpSearchHit } from "../help/help.index.js";
import { formatSources, judgeGrounding, parseGrounding, retrievalQuery } from "./ai.assist.js";

const hit = (articleId: string, text = "Some text."): HelpSearchHit => ({
  chunkId: `${articleId}#0`, articleId, sectionTitle: "Overview", text, score: 1, matchedBy: "keyword",
});

test("short follow-ups are searched together with the previous question", () => {
  const history = [
    { role: "user" as const, content: "how do I invite people" },
    { role: "assistant" as const, content: "Open Members…" },
  ];
  assert.equal(retrievalQuery("and how do I cancel it?", history), "how do I invite people and how do I cancel it?");
  assert.equal(retrievalQuery("how do I connect GitHub to my workspace please", history), "how do I connect GitHub to my workspace please");
  assert.equal(retrievalQuery("cancel it?", []), "cancel it?");
});

test("sources are numbered from 1, titled from the article, and kept within budget", () => {
  const { text, byNumber } = formatSources([hit("members-and-invites"), hit("roles-and-permissions"), hit("x", "y".repeat(5_000))]);
  assert.match(text, /^\[1\] Members and invitations › Overview\nSome text\./);
  assert.match(text, /\[2\] Roles and permissions › Overview/);
  assert.equal(byNumber.get(1)!.articleId, "members-and-invites");
  assert.ok(text.length <= 7_000);
  const many = formatSources(Array.from({ length: 9 }, (_, i) => hit(`a${i}`)));
  assert.equal(many.byNumber.size, 5, "at most five sources");
});

test("malformed grounding counts as no basis and low confidence", () => {
  assert.deepEqual(parseGrounding(null), { basis: "none", sources: [], confidence: "low" });
  assert.deepEqual(parseGrounding({ basis: "help", sources: ["2", 2, -1, 1.5, "x"], confidence: "high" }), { basis: "help", sources: [2], confidence: "high" });
});

test("an answer is only shown when it rests on sources it was given, or on workspace facts", () => {
  const byNumber = new Map([[1, hit("members-and-invites")], [2, hit("members-and-invites")], [3, hit("teams")]]);
  assert.deepEqual(judgeGrounding({ basis: "help", sources: [1, 2, 3], confidence: "high" }, byNumber), { ok: true, articleIds: ["members-and-invites", "teams"] });
  assert.equal(judgeGrounding({ basis: "help", sources: [9], confidence: "high" }, byNumber).ok, false, "an invented source number doesn't count");
  assert.equal(judgeGrounding({ basis: "help", sources: [], confidence: "high" }, byNumber).ok, false);
  assert.equal(judgeGrounding({ basis: "help", sources: [1], confidence: "low" }, byNumber).ok, false);
  assert.equal(judgeGrounding({ basis: "workspace", sources: [], confidence: "high" }, byNumber).ok, true);
  assert.equal(judgeGrounding({ basis: "none", sources: [1], confidence: "high" }, byNumber).ok, false);
});
