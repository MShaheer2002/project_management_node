import test from "node:test";
import assert from "node:assert/strict";
import { AssistStreamParser, partialMarkerLength } from "./ai.assist-stream.js";

const OUTPUT =
  '{"basis":"help","sources":[1],"confidence":"high","title":"Invite people"}\n@@ANSWER@@\n' +
  "1. Open **Members**.\n2. Click Invite.\n" +
  '@@END@@\n{"followUps":["Who can invite?"],"navigation":{"route":"/members","label":"Open Members"}}';

function feed(chunks: string[]) {
  const parser = new AssistStreamParser();
  let header: unknown;
  let streamed = "";
  for (const chunk of chunks) {
    const out = parser.push(chunk);
    if (out.header) header = out.header;
    if (out.delta) {
      assert.ok(header, "no answer text before the header was read");
      streamed += out.delta;
    }
  }
  return { header, streamed, final: parser.end() };
}

test("output split at every possible point streams exactly the answer, never a marker", () => {
  for (let cut = 1; cut < OUTPUT.length; cut++) {
    const { header, streamed, final } = feed([OUTPUT.slice(0, cut), OUTPUT.slice(cut)]);
    assert.deepEqual(header, { basis: "help", sources: [1], confidence: "high", title: "Invite people" }, `cut ${cut}`);
    assert.equal(streamed, "1. Open **Members**.\n2. Click Invite.\n", `cut ${cut}`);
    assert.ok(!streamed.includes("@@"), `cut ${cut}`);
    assert.equal(final.mode, "structured");
    if (final.mode === "structured") {
      assert.equal(final.answer, "1. Open **Members**.\n2. Click Invite.");
      assert.deepEqual(final.footer, { followUps: ["Who can invite?"], navigation: { route: "/members", label: "Open Members" } });
    }
  }
});

test("one character at a time works too", () => {
  const { streamed, final } = feed([...OUTPUT]);
  assert.equal(streamed.trim(), "1. Open **Members**.\n2. Click Invite.");
  assert.equal(final.mode, "structured");
});

test("a reply that ignores the format is kept whole and never streamed", () => {
  const legacy = '{"answer":"Open Members.","basis":"help","sources":[1],"confidence":"high"}';
  const { header, streamed, final } = feed([legacy]);
  assert.equal(header, undefined);
  assert.equal(streamed, "");
  assert.deepEqual(final, { mode: "raw", text: legacy });

  const rambling = feed(["x".repeat(2_000), "@@ANSWER@@ hi"]);
  assert.equal(rambling.final.mode, "raw", "a header that never ends switches to raw");
});

test("a missing end marker or footer still gives the answer", () => {
  const { final } = feed(['{"basis":"help","sources":[1],"confidence":"high"}@@ANSWER@@Just this.']);
  assert.deepEqual(final, { mode: "structured", answer: "Just this.", footer: {} });
});

test("an unreadable header falls back to raw", () => {
  assert.equal(feed(["{not json}@@ANSWER@@text"]).final.mode, "raw");
});

test("partial marker detection", () => {
  assert.equal(partialMarkerLength("hello @@EN", "@@END@@"), 4);
  assert.equal(partialMarkerLength("hello", "@@END@@"), 0);
  assert.equal(partialMarkerLength("a@", "@@END@@"), 1);
});
