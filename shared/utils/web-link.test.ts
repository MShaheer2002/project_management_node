import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../../config/env.js";
import { isWebLink } from "./web-link.js";
import { resolveAttachmentRefs } from "../../modules/issue/issue-attachment.service.js";
import { validateDocumentRef } from "../../modules/documents/documents.storage.js";
import { createIssueSchema } from "../../modules/issue/issue.schemas.js";
import { createCommentSchema } from "../../modules/comment/comment.schemas.js";

const bad = ["javascript:alert(1)", " JavaScript:alert(1)", "javascript:alert(1)//drive.google.com", "data:text/html,<script>", "vbscript:x", "file:///etc/passwd", "not a url"];

test("only http and https count as web links (N-06)", () => {
  assert.equal(isWebLink("https://drive.google.com/file/d/x/view"), true);
  assert.equal(isWebLink("http://cdn.example.com/a.png"), true);
  for (const url of bad) assert.equal(isWebLink(url), false, url);
});

const key = `${env.AWS_S3_UPLOAD_PREFIX.replace(/\/$/, "")}/workspaces/ws/a.png`;
const file = (assetUrl: string) => ({ key, fileName: "a.png", contentType: "image/png", size: 5, kind: "attachment" as const, assetUrl });

test("issue and comment attachments reject non web links", () => {
  const issue = (assetUrl: string) => createIssueSchema.body.safeParse({ title: "t", type: "task", projectId: "00000000-0000-4000-8000-000000000000", priority: "low", attachments: [file(assetUrl)] }).success;
  const comment = (assetUrl: string) => createCommentSchema.body.safeParse({ body: "hi", attachments: [file(assetUrl)] }).success;
  assert.equal(issue("https://cdn.example.com/a.png"), true);
  assert.equal(comment("https://cdn.example.com/a.png"), true);
  for (const url of bad) {
    assert.equal(issue(url), false, url);
    assert.equal(comment(url), false, url);
  }
});

test("services drop non web links even when the schema was skipped (AI tools)", async () => {
  const db = { driveUpload: { findMany: async () => [] } } as never;
  const [kept] = await resolveAttachmentRefs(db, "ws", [file("https://cdn.example.com/a.png")]);
  assert.equal(kept!.assetUrl, "https://cdn.example.com/a.png");
  const [dropped] = await resolveAttachmentRefs(db, "ws", [file("javascript:alert(1)")]);
  assert.equal(dropped!.assetUrl, null);

  assert.equal(validateDocumentRef("ws", { ...file("javascript:alert(1)"), contentType: "application/pdf", kind: "document" } as never).fileUrl, null);
  assert.equal(validateDocumentRef("ws", { ...file("https://x.test/a.pdf"), contentType: "application/pdf", kind: "document" } as never).fileUrl, "https://x.test/a.pdf");
});
