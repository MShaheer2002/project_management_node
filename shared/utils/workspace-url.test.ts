import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../../config/env.js";
import { prisma } from "./prisma.js";
import { oauthReturnUrl, workspaceAppBase, workspaceAppUrl } from "./workspace-url.js";
import { createOAuthState, oauthStateWorkspaceId } from "../../modules/integration/oauth-state.js";

const host = new URL(env.FRONTEND_URL).host;

test("workspace URLs live on the workspace's own subdomain", () => {
  const url = new URL(workspaceAppUrl("oneguytech", "/settings?tab=integrations&provider=drive&status=connected"));
  assert.equal(url.host, `oneguytech.${host}`);
  assert.equal(url.pathname, "/settings");
  assert.equal(url.searchParams.get("status"), "connected");
});

test("an OAuth callback returns to the workspace the flow started in", async () => {
  prisma.workspace.findUnique = (async () => ({ slug: "oneguytech" })) as never;
  const state = createOAuthState("ws-1", "user_1");
  assert.equal(oauthStateWorkspaceId(state), "ws-1");
  assert.equal(new URL(await oauthReturnUrl(oauthStateWorkspaceId(state), "/x")).host, `oneguytech.${host}`);
});

test("an untrusted or unknown state falls back to the bare app, never another tenant", async () => {
  const forged = Buffer.from(JSON.stringify({ payload: JSON.stringify({ workspaceId: "victim" }), sig: "x" })).toString("base64url");
  assert.equal(oauthStateWorkspaceId(forged), null);
  assert.equal(oauthStateWorkspaceId(undefined), null);
  assert.equal(new URL(await oauthReturnUrl(null, "/x")).host, host);
  prisma.workspace.findUnique = (async () => null) as never;
  assert.equal(new URL(await oauthReturnUrl("deleted-ws", "/x")).host, host);
});

test("Slack and Discord links use the workspace's own address, with no trailing slash", async () => {
  prisma.workspace.findUnique = (async () => ({ slug: "acme" })) as never;
  const base = await workspaceAppBase("ws-1");
  assert.equal(new URL(base).host, `acme.${host}`);
  assert.ok(!base.endsWith("/"));
  assert.equal(new URL(`${base}/issues/ACME-1`).pathname, "/issues/ACME-1");
});
