import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../shared/utils/prisma.js";
import { encrypt } from "./drive.crypto.js";
import { createOAuthState } from "../integration/oauth-state.js";
import { handleCallback, uploadFileToDrive } from "./drive.service.js";
import { isScopeError } from "./drive.sharing.js";

const SCOPE_ERROR = { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } };

test("Google's 'insufficient scopes' answer is recognised", () => {
  assert.equal(isScopeError(403, SCOPE_ERROR), true);
  assert.equal(isScopeError(403, { error: { message: "The user does not have sufficient permissions for this file." } }), false);
  assert.equal(isScopeError(500, SCOPE_ERROR), false);
});

test("connecting without ticking the Drive box is refused and the partial grant revoked", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(new URL(url).pathname);
    return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "https://www.googleapis.com/auth/userinfo.email openid" }));
  }) as never;
  prisma.user.findUnique = (async () => ({ id: "user_1", deletedAt: null })) as never;
  let saved = false;
  prisma.userDriveConnection.upsert = (async () => { saved = true; return {}; }) as never;

  await assert.rejects(handleCallback("code", createOAuthState("ws-1", "user_1")), (e: { code?: string }) => e.code === "DRIVE_SCOPE_MISSING");
  assert.equal(saved, false, "no half-working connection is stored");
  assert.ok(calls.includes("/revoke"), "the partial grant is revoked");
});

test("a saved connection without the Drive permission is marked for reconnect", async () => {
  prisma.userDriveConnection.findUnique = (async () => ({
    id: "c1", email: "a@acme.com", connected: true, accessToken: encrypt("at"), refreshToken: encrypt("rt"),
    tokenExpiresAt: new Date(Date.now() + 3600_000),
  })) as never;
  prisma.workspace.findUnique = (async () => ({ allowPublicDriveLinks: false })) as never;
  prisma.workspaceMembership.findUnique = (async () => ({ driveUploadTarget: "WORKSPACE" })) as never;
  prisma.workspaceDriveConnection.findUnique = (async () => null) as never;   // no Workspace Drive: personal is used
  let disconnected = false;
  prisma.userDriveConnection.updateMany = (async (args: { data: { connected: boolean } }) => { disconnected = args.data.connected === false; return { count: 1 }; }) as never;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    (init?.method ?? "GET") === "GET"
      ? new Response(JSON.stringify({ files: [] }))                 // folder lookup
      : new Response(JSON.stringify(SCOPE_ERROR), { status: 403 })   // folder create
  ) as never;

  await assert.rejects(
    uploadFileToDrive("user_1", "ws-1", { path: "/nonexistent", originalname: "a.pdf", mimetype: "application/pdf", size: 1 }, ["Trussen"]),
    (e: { code?: string; message?: string }) => e.code === "DRIVE_SCOPE_MISSING" && /tick the Google Drive box/.test(e.message ?? ""),
  );
  assert.equal(disconnected, true);
});
