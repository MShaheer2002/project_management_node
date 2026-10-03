import test from "node:test";
import assert from "node:assert/strict";
import { createAiSetupTicket, createOAuthState, isValidAiSetupTicket, verifyOAuthState } from "./oauth-state.js";

const CODE = "GITHUB_OAUTH_FAILED";
const decode = (state: string) => JSON.parse(Buffer.from(state, "base64url").toString());
const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");

test("a state round-trips to the workspace and user it was issued for", () => {
  const state = createOAuthState("ws-1", "u-1");
  assert.deepEqual(verifyOAuthState(state, CODE), { workspaceId: "ws-1", userId: "u-1", mode: null });
  // A connect mode travels signed with the rest.
  assert.equal(verifyOAuthState(createOAuthState("ws-1", "u-1", "WORKSPACE"), CODE).mode, "WORKSPACE");
});

test("swapping workspaceId without re-signing is rejected (F-01)", () => {
  // The whole attack: take your own authUrl's state, point it at a victim
  // workspace, complete the consent with your own GitHub account.
  const { payload, sig } = decode(createOAuthState("ws-attacker", "u-1"));
  const forged = encode({ payload: payload.replace("ws-attacker", "ws-victim"), sig });

  assert.throws(() => verifyOAuthState(forged, CODE), /signature/i);
});

test("an unsigned state of the old shape is rejected", () => {
  const legacy = encode({ workspaceId: "ws-victim", userId: "u-any" });
  assert.throws(() => verifyOAuthState(legacy, CODE), /Malformed|Invalid/i);
});

test("an expired state is rejected", () => {
  const state = createOAuthState("ws-1", "u-1");
  const original = Date.now;
  try {
    Date.now = () => original() + 11 * 60 * 1000;
    assert.throws(() => verifyOAuthState(state, CODE), /expired/i);
  } finally {
    Date.now = original;
  }
});

test("an AI setup ticket only works for the user and client it was issued to (FE-N-03)", () => {
  const ticket = createAiSetupTicket("u-1", "client-a");
  assert.equal(isValidAiSetupTicket(ticket, "u-1", "client-a"), true);
  assert.equal(isValidAiSetupTicket(ticket, "u-2", "client-a"), false);
  assert.equal(isValidAiSetupTicket(ticket, "u-1", "client-attacker"), false);

  const { payload, sig } = decode(ticket);
  const forged = encode({ payload: payload.replace("client-a", "client-attacker"), sig });
  assert.equal(isValidAiSetupTicket(forged, "u-1", "client-attacker"), false);

  const expiredPayload = JSON.stringify({ ...JSON.parse(payload), exp: Date.now() - 1 });
  assert.equal(isValidAiSetupTicket(encode({ payload: expiredPayload, sig }), "u-1", "client-a"), false);

  // An integration state can't stand in for a ticket, and junk never throws.
  assert.equal(isValidAiSetupTicket(createOAuthState("ws-1", "u-1"), "u-1", "client-a"), false);
  assert.equal(isValidAiSetupTicket("not-a-ticket", "u-1", "client-a"), false);
});
