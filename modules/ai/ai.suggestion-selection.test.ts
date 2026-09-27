import test from "node:test";
import assert from "node:assert/strict";
import { resolveSelection } from "./ai.suggestions.js";

const CANDIDATES = ["u-alice", "u-bob"];

test("omitting a selection applies every candidate", () => {
  assert.deepEqual(resolveSelection(undefined, CANDIDATES, "assignee"), CANDIDATES);
  assert.deepEqual(resolveSelection([], CANDIDATES, "assignee"), CANDIDATES);
});

test("choosing a subset of the candidates is allowed", () => {
  assert.deepEqual(resolveSelection(["u-bob"], CANDIDATES, "assignee"), ["u-bob"]);
});

test("an id outside the suggestion is rejected (F-24)", () => {
  // The attack: accept an ASSIGNEE suggestion but name any workspace member,
  // or a SPRINT_PLANNING suggestion but name arbitrary issues.
  assert.throws(
    () => resolveSelection(["u-someone-else"], CANDIDATES, "assignee"),
    /not part of this suggestion/,
  );
});

test("a smuggled id alongside valid ones is rejected, not silently dropped", () => {
  assert.throws(
    () => resolveSelection(["u-alice", "u-someone-else"], CANDIDATES, "issues"),
    /not part of this suggestion/,
  );
});

test("an empty candidate set cannot be used to apply anything", () => {
  assert.deepEqual(resolveSelection(undefined, [], "issues"), []);
  assert.throws(() => resolveSelection(["anything"], [], "issues"), /not part of this suggestion/);
});
