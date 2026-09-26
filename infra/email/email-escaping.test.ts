import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, sanitizeSubjectValue } from "./index.js";

// The audit's payload: a workspace name that closes the surrounding tag and
// injects a phishing link into an email that passes SPF/DKIM as Trussen.
const PAYLOAD = '</strong><a href="https://evil.example">Verify your Trussen account</a>';

test("a workspace name cannot break out of its tag (F-22)", () => {
  const escaped = escapeHtml(PAYLOAD);
  assert.equal(escaped.includes("<a"), false, "an anchor tag survived escaping");
  assert.equal(escaped.includes("</strong>"), false, "the closing tag survived escaping");
  assert.ok(escaped.includes("&lt;"), "nothing was escaped at all");
});

test("every HTML-significant character is escaped", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("ampersands are escaped first, so escaping is not applied twice", () => {
  // Escaping < before & would turn "<" into "&lt;" and then "&amp;lt;".
  assert.equal(escapeHtml("a & b < c"), "a &amp; b &lt; c");
});

test("ordinary names survive unchanged", () => {
  for (const name of ["Acme Corp", "Ridely", "R&D Team"]) {
    assert.equal(escapeHtml(name).includes("&lt;"), false);
  }
});

test("the subject strips CR/LF instead of HTML-escaping (header injection)", () => {
  // A subject is plain text: escaping would show a literal "&amp;" to the
  // recipient, while CR/LF is what forges extra headers.
  const injected = "Hello\r\nBcc: victim@example.com";
  const clean = sanitizeSubjectValue(injected);
  assert.equal(/[\r\n]/.test(clean), false, "newlines survived");
  assert.equal(clean.includes("Bcc:"), true, "text should be kept, only control chars removed");
  assert.equal(sanitizeSubjectValue("R&D sprint"), "R&D sprint");
});
