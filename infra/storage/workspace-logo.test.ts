import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../../config/env.js";
import { isWorkspaceLogoUrl, workspaceLogoKey } from "./s3.js";
import { publicWorkspaceLogo } from "../../modules/workspace/workspace-logo.js";
import { prisma } from "../../shared/utils/prisma.js";
import { updateWorkspace } from "../../modules/workspace/workspace.service.js";

const WS = "2f7c1a4e-9b1d-4c3e-8a55-0d6b9e1f2a3c";
const OTHER = "9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const FILE = "2026/09/5b3e9d2a-7c41-4f0e-9a6b-1c2d3e4f5a6b.png";

const base = env.AWS_S3_PUBLIC_BASE_URL?.replace(/\/$/, "");
const logoUrl = (workspaceId: string, file = FILE) => `${base}/${env.AWS_S3_UPLOAD_PREFIX}/workspaces/${workspaceId}/workspace-logo/${file}`;

test("a logo uploaded to the workspace's own logo folder is accepted", { skip: !base && "AWS_S3_PUBLIC_BASE_URL not set" }, () => {
  assert.equal(isWorkspaceLogoUrl(WS, logoUrl(WS)), true);
  for (const ext of ["gif", "jpg", "webp"]) {
    assert.equal(isWorkspaceLogoUrl(WS, logoUrl(WS, FILE.replace(".png", `.${ext}`))), true, ext);
  }
});

test("anything else is rejected (F-36)", { skip: !base && "AWS_S3_PUBLIC_BASE_URL not set" }, () => {
  const rejected = [
    "https://tracker.example/p.gif?w=acme",                                  // the tracking pixel
    logoUrl(OTHER),                                                           // another workspace's logo
    logoUrl(WS).replace("/workspace-logo/", "/attachment/"),                  // an attachment, not a logo
    `${logoUrl(WS)}?track=1`,                                                 // query string
    `${logoUrl(WS)}#x`,
    logoUrl(WS, "2026/09/../../../x.png"),                                    // path tricks
    logoUrl(WS, "2026/09/tracker.png"),                                       // not a generated name
    logoUrl(WS, FILE.replace(".png", ".svg")),                                // not an allowed image type
    logoUrl(WS).replace(base!, "https://evil.example"),                       // same path, other host
    `https://evil.example/?u=${logoUrl(WS)}`,
    `${base}.evil.example/${env.AWS_S3_UPLOAD_PREFIX}/workspaces/${WS}/workspace-logo/${FILE}`, // host-prefix trick
  ];
  for (const url of rejected) assert.equal(isWorkspaceLogoUrl(WS, url), false, url);
});

test("the S3 key is derived only from a valid logo URL", { skip: !base && "AWS_S3_PUBLIC_BASE_URL not set" }, () => {
  assert.equal(workspaceLogoKey(WS, logoUrl(WS)), `${env.AWS_S3_UPLOAD_PREFIX}/workspaces/${WS}/workspace-logo/${FILE}`);
  assert.equal(workspaceLogoKey(WS, "https://tracker.example/p.gif"), null);
});

test("clients get our own logo route, never the stored URL", { skip: !base && "AWS_S3_PUBLIC_BASE_URL not set" }, () => {
  const served = publicWorkspaceLogo({ id: WS, logo: logoUrl(WS) })!;
  assert.match(served, new RegExp(`/workspaces/${WS}/logo\\?v=5b3e9d2a-7c41-4f0e-9a6b-1c2d3e4f5a6b$`));
  // Legacy or foreign logos are never served.
  assert.equal(publicWorkspaceLogo({ id: WS, logo: "https://tracker.example/p.gif" }), null);
  assert.equal(publicWorkspaceLogo({ id: WS, logo: logoUrl(OTHER) }), null);
  assert.equal(publicWorkspaceLogo({ id: WS, logo: null }), null);
});

test("updateWorkspace refuses an outside logo — the AI tool goes through here too", async () => {
  let written = false;
  prisma.workspace.findUnique = (async () => ({ id: WS, logo: null })) as never;
  prisma.workspace.update = (async () => { written = true; return {}; }) as never;

  await assert.rejects(
    updateWorkspace(WS, { logo: "https://tracker.example/p.gif" }),
    (error: { statusCode?: number }) => error.statusCode === 422,
  );
  assert.equal(written, false, "nothing may be stored");
});

test("updateWorkspace stores an empty logo as cleared", async () => {
  let data: Record<string, unknown> = {};
  prisma.workspace.update = (async (args: { data: Record<string, unknown> }) => {
    data = args.data;
    return { id: WS, logo: null, customStatuses: [], workflowAutomation: {} };
  }) as never;

  await updateWorkspace(WS, { logo: "   " as never });
  assert.equal(data.logo, null);
});

test("sending back the served logo address keeps the current logo", { skip: !base && "AWS_S3_PUBLIC_BASE_URL not set" }, async () => {
  const current = { id: WS, logo: logoUrl(WS) };
  prisma.workspace.findUnique = (async () => current) as never;
  let data: Record<string, unknown> = {};
  prisma.workspace.update = (async (args: { data: Record<string, unknown> }) => {
    data = args.data;
    return { ...current, customStatuses: [], workflowAutomation: {} };
  }) as never;

  await updateWorkspace(WS, { name: "Acme", logo: publicWorkspaceLogo(current)! });
  assert.equal("logo" in data, false, "logo must be left as it is");
});
