import test from "node:test";
import assert from "node:assert/strict";
import { csvEscape } from "./analytics.utils.js";

test("a formula in a member-controlled name is neutralised (F-26)", () => {
  // The audit's payload: a project named this, exported, opened in Excel.
  const payload = '=HYPERLINK("https://evil.example","Open")';
  const cell = csvEscape(payload);
  assert.ok(cell.startsWith(`"'=`) || cell.startsWith("'="), `not guarded: ${cell}`);
  assert.equal(cell.startsWith("="), false, "cell still begins with =");
});

test("every formula lead character is guarded", () => {
  for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
    const cell = csvEscape(`${lead}cmd`);
    assert.ok(cell.includes(`'${lead}`), `${JSON.stringify(lead)} was not guarded`);
  }
});

test("numbers stay numeric — a negative is not turned into text", () => {
  // Analytics exports are full of counts and deltas; guarding -5 would make
  // every negative unusable in a spreadsheet.
  assert.equal(csvEscape(-5), "-5");
  assert.equal(csvEscape(0), "0");
  assert.equal(csvEscape(12.5), "12.5");
  assert.equal(csvEscape(true), "true");
});

test("ordinary text is untouched", () => {
  assert.equal(csvEscape("Ridely"), "Ridely");
  assert.equal(csvEscape("Sprint 12"), "Sprint 12");
  assert.equal(csvEscape(null), "");
});

test("quote and delimiter escaping still applies", () => {
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape("line1\nline2"), '"line1\nline2"');
  assert.equal(csvEscape("line1\r\nline2"), '"line1\r\nline2"');
});

test("a formula that also needs quoting gets both treatments", () => {
  const cell = csvEscape('=SUM(1,2)');
  assert.equal(cell, `"'=SUM(1,2)"`);
});
