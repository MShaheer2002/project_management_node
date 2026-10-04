import test from "node:test";
import assert from "node:assert/strict";
import type { HelpArticle } from "./help.content.js";
import { loadHelpArticles } from "./help.content.js";
import { articlesForRoute, chunkHelpArticle, fuseRankings } from "./help.index.js";

const base: HelpArticle = {
  id: "sample",
  title: "Sample",
  category: "Issues",
  route: "/issues/:id",
  primary: true,
  roles: ["OWNER", "MEMBER"],
  plans: ["FREE"],
  keywords: ["sample", "demo"],
  summary: "A sample article.",
  body: "Intro text.\n\n## Create\n\nHow to create.\n\n## Delete\n\nHow to delete.",
};

test("an article becomes an Overview chunk plus one chunk per section, each carrying its context", () => {
  const chunks = chunkHelpArticle(base, "model-a");
  assert.deepEqual(chunks.map((c) => [c.id, c.sectionTitle]), [["sample#0", "Overview"], ["sample#1", "Create"], ["sample#2", "Delete"]]);
  for (const chunk of chunks) {
    assert.match(chunk.content, /^Article: Sample\nCategory: Issues\nAbout: A sample article\.\nKeywords: sample, demo\nSection: /);
    assert.deepEqual(chunk.roles, ["OWNER", "MEMBER"]);
  }
  assert.match(chunks[1]!.content, /\n\nHow to create\.$/);
});

test("the content hash changes with the text and with the embedding model, nothing else", () => {
  const [a] = chunkHelpArticle(base, "model-a");
  const [again] = chunkHelpArticle(base, "model-a");
  const [otherModel] = chunkHelpArticle(base, "model-b");
  const [edited] = chunkHelpArticle({ ...base, body: base.body.replace("Intro text.", "Intro changed.") }, "model-a");
  assert.equal(a!.contentHash, again!.contentHash);
  assert.notEqual(a!.contentHash, otherModel!.contentHash);
  assert.notEqual(a!.contentHash, edited!.contentHash);
});

test("a very long section is split at paragraph boundaries, never mid paragraph", () => {
  const paragraph = "word ".repeat(200).trim();
  const body = `## Long\n\n${Array.from({ length: 6 }, () => paragraph).join("\n\n")}`;
  const chunks = chunkHelpArticle({ ...base, body }, "m");
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0]!.sectionTitle, "Long");
  assert.ok(chunks.slice(1).every((c) => c.sectionTitle === "Long (continued)"));
  for (const chunk of chunks) assert.ok(!chunk.content.endsWith("word wor"));
});

test("every real article chunks cleanly, with unique ids", () => {
  const chunks = loadHelpArticles().flatMap((article) => chunkHelpArticle(article, "m"));
  assert.ok(chunks.length > 100);
  assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length);
  assert.ok(chunks.every((c) => c.content.length < 4_000));
});

const row = (id: string, articleId = id.split("#")[0]!) => ({ id, articleId, sectionTitle: "S", content: `Article: x\n\nText of ${id}` });

test("results found by both keyword and meaning rank above results found by one", () => {
  const hits = fuseRankings([row("a#0"), row("b#0")], [row("b#0"), row("c#0")]);
  assert.equal(hits[0]!.chunkId, "b#0");
  assert.equal(hits[0]!.matchedBy, "both");
  assert.equal(hits[0]!.text, "Text of b#0");
  assert.deepEqual(new Set(hits.map((h) => h.chunkId)), new Set(["a#0", "b#0", "c#0"]));
});

test("the current page breaks ties between matches but never adds or overrides one", () => {
  const plain = fuseRankings([row("a#0"), row("b#0")], [row("a#0"), row("b#0")]);
  assert.equal(plain[0]!.chunkId, "a#0");
  // b is right behind a: the page boost lifts it.
  assert.equal(fuseRankings([row("a#0"), row("b#0")], [], new Set(["b"]))[0]!.chunkId, "b#0");
  // a clearly leads (found by both methods): the boost on b isn't enough.
  assert.equal(fuseRankings([row("a#0"), row("b#0")], [row("a#0")], new Set(["b"]))[0]!.chunkId, "a#0");
  // An article that didn't match is never added because of the page.
  assert.ok(!fuseRankings([row("a#0")], [], new Set(["c"])).some((hit) => hit.articleId === "c"));
});

test("at most two sections per article", () => {
  const hits = fuseRankings([row("a#0"), row("a#1"), row("a#2"), row("b#0")], []);
  assert.deepEqual(hits.map((h) => h.chunkId), ["a#0", "a#1", "b#0"]);
});

test("page matching understands :id routes and ignores query strings", () => {
  const articles = [{ ...base, id: "detail", route: "/issues/:id" }, { ...base, id: "list", route: "/issues" }, { ...base, id: "none", route: null }];
  assert.deepEqual([...articlesForRoute(articles, "/issues/ACME-12")], ["detail"]);
  assert.deepEqual([...articlesForRoute(articles, "/issues?team=1")], ["list"]);
  assert.deepEqual([...articlesForRoute(articles, undefined)], []);
});
