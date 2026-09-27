import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../../shared/utils/prisma.js";
import { batchPreviewFigmaFiles } from "./figma.service.js";

const LINKED = "https://www.figma.com/design/AbC123linked/Onboarding";
const IN_REFS = "https://www.figma.com/file/Ref456attached/Specs";
const FOREIGN = "https://www.figma.com/design/Xyz789private/Other-client";

function stub(options: { visible: boolean }) {
  const fetched: string[] = [];
  prisma.issue.findFirst = (async () => options.visible
    ? { id: "W-1", description: `<p>Design: <a href="${LINKED}?node-id=1-2&amp;t=x">here</a></p>`, integrationRef: [{ id: "r1", provider: "figma", url: IN_REFS }] }
    : null) as never;
  prisma.integration.findUnique = (async () => ({ id: "i1", connected: true, accessToken: "admin-token", workspace: { deactivatedAt: null } })) as never;
  globalThis.fetch = (async (url: string) => {
    fetched.push(new URL(url).pathname);
    return new Response(JSON.stringify({ name: "File", thumbnailUrl: "t", lastModified: "d", version: "1" }));
  }) as never;
  return fetched;
}

const viewer = { userId: "u1", role: "GUEST" } as const;

test("only Figma links that are in the issue are previewed (F-41)", async () => {
  const fetched = stub({ visible: true });
  const result = await batchPreviewFigmaFiles("ws", viewer, "W-1", [LINKED, IN_REFS, FOREIGN]);

  assert.deepEqual(result.map((r) => r.fileKey).sort(), ["AbC123linked", "Ref456attached"]);
  assert.ok(!fetched.some((path) => path.includes("Xyz789private")), "a file not linked from the issue is never looked up with the admin's token");
});

test("an issue the caller can't see gets no previews", async () => {
  const fetched = stub({ visible: false });
  await assert.rejects(batchPreviewFigmaFiles("ws", viewer, "W-1", [LINKED]), (e: { statusCode?: number }) => e.statusCode === 404);
  assert.deepEqual(fetched, []);
});
