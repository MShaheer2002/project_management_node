import test from "node:test";
import assert from "node:assert/strict";
import type { Socket } from "socket.io";
import { prisma } from "../shared/utils/prisma.js";
import { startSessionRevalidation } from "./auth.js";

/** Minimal stand-in for the parts of Socket the revalidation loop touches. */
function fakeSocket(overrides: Record<string, unknown> = {}) {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const handlers: Record<string, () => void> = {};
  const state = {
    id: "sock-1",
    disconnected: false,
    emitted,
    data: {
      userId: "u-1",
      workspaceId: "ws-1",
      role: "MEMBER",
      tokenExp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    },
    emit(event: string, payload: unknown) { emitted.push({ event, payload }); },
    on(event: string, fn: () => void) { handlers[event] = fn; },
    disconnect() { state.disconnected = true; handlers.disconnect?.(); },
  };
  return state;
}

const ACTIVE = { deactivatedAt: null };

const revokedReason = (socket: ReturnType<typeof fakeSocket>) =>
  socket.emitted.find((e) => e.event === "session:revoked")?.payload as { reason: string } | undefined;

/**
 * Wait for a revocation, polling rather than sleeping a fixed interval.
 *
 * A fixed sleep makes this flaky under load: the revalidation tick is async, so
 * on a busy machine it may not have completed when a short sleep elapses, and
 * the test fails for reasons unrelated to the code.
 */
async function expectRevoked(socket: ReturnType<typeof fakeSocket>, timeoutMs = 5000) {
  startSessionRevalidation(socket as unknown as Socket, 5);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reason = revokedReason(socket);
    if (reason) return reason;
    await new Promise((r) => setTimeout(r, 5));
  }
  return undefined;
}

/**
 * Give the loop several ticks and assert nothing happened. A false pass here is
 * harmless; a false failure is the thing worth avoiding.
 */
async function expectStillConnected(socket: ReturnType<typeof fakeSocket>) {
  startSessionRevalidation(socket as unknown as Socket, 5);
  await new Promise((r) => setTimeout(r, 120));
  return revokedReason(socket);
}

test("a still-valid session is left connected", async () => {
  prisma.workspaceMembership.findUnique = (async () => ({ role: "MEMBER", workspace: ACTIVE })) as never;
  const socket = fakeSocket();
  assert.equal(await expectStillConnected(socket), undefined);
  assert.equal(socket.disconnected, false);
  socket.disconnect();
});

test("a removed member is disconnected instead of kept on the broadcast (F-17)", async () => {
  prisma.workspaceMembership.findUnique = (async () => null) as never;
  const socket = fakeSocket();
  assert.deepEqual(await expectRevoked(socket), { reason: "MEMBERSHIP_REVOKED" });
  assert.equal(socket.disconnected, true);
});

test("a role change ends the session so rooms are rebuilt on reconnect", async () => {
  // socket.data.role drives private-project room membership (rooms.ts), so a
  // stale role must not be patched in place.
  prisma.workspaceMembership.findUnique = (async () => ({ role: "GUEST", workspace: ACTIVE })) as never;
  const socket = fakeSocket({ role: "ADMIN" });
  assert.deepEqual(await expectRevoked(socket), { reason: "ROLE_CHANGED" });
  assert.equal(socket.disconnected, true);
});

test("deactivating the workspace ends every live session, the owner's included", async () => {
  prisma.workspaceMembership.findUnique = (async () => ({ role: "OWNER", workspace: { deactivatedAt: new Date() } })) as never;
  const socket = fakeSocket({ role: "OWNER" });
  assert.deepEqual(await expectRevoked(socket), { reason: "WORKSPACE_DEACTIVATED" });
  assert.equal(socket.disconnected, true);
});

test("an expired token ends the session without hitting the database", async () => {
  let queried = false;
  prisma.workspaceMembership.findUnique = (async () => { queried = true; return { role: "MEMBER", workspace: ACTIVE }; }) as never;
  const socket = fakeSocket({ tokenExp: Math.floor(Date.now() / 1000) - 1 });
  assert.deepEqual(await expectRevoked(socket), { reason: "TOKEN_EXPIRED" });
  assert.equal(queried, false);
});

test("a transient database error does not disconnect a legitimate user", async () => {
  // Failing open here is deliberate and bounded: the next tick re-checks.
  prisma.workspaceMembership.findUnique = (async () => { throw new Error("connection reset"); }) as never;
  const socket = fakeSocket();
  assert.equal(await expectStillConnected(socket), undefined);
  assert.equal(socket.disconnected, false);
  socket.disconnect();
});
