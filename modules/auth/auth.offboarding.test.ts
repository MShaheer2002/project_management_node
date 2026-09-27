import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../shared/utils/prisma.js";
import { deleteUser } from "./auth.service.js";

/** Records what the offboarding transaction was asked to do, without a DB. */
function captureTransaction() {
  const calls: string[] = [];
  const stub = (label: string) => (async (args: unknown) => { calls.push(`${label}:${JSON.stringify(args)}`); return args; }) as never;

  prisma.user.update = stub("user.update");
  prisma.apiKey.deleteMany = stub("apiKey.revoke");
  prisma.aiConnection.updateMany = stub("aiConnection.revoke");
  prisma.userDriveConnection.deleteMany = stub("drive.delete");
  prisma.projectMembership.deleteMany = stub("projectMembership.delete");
  prisma.teamMembership.deleteMany = stub("teamMembership.delete");
  prisma.departmentMembership.deleteMany = stub("departmentMembership.delete");
  prisma.workspaceMembership.deleteMany = stub("workspaceMembership.delete");
  prisma.$transaction = (async (ops: unknown[]) => await Promise.all(ops as Promise<unknown>[])) as never;
  prisma.workspaceDriveConnection.findMany = (async () => []) as never;

  // Deleting the row is what used to fail against RESTRICT foreign keys.
  prisma.user.delete = (async () => { throw new Error("user.delete must never be called"); }) as never;

  return calls;
}

test("offboarding revokes every access path and never hard-deletes (F-19)", async () => {
  prisma.user.findUnique = (async () => ({ id: "u-1", deletedAt: null })) as never;
  const calls = captureTransaction();

  await deleteUser("u-1");

  const kinds = calls.map((c) => c.split(":")[0]);
  for (const required of [
    "user.update",                 // deletedAt stamped
    "apiKey.revoke",               // lin_live_* keys stop working
    "aiConnection.revoke",         // MCP/PAT connections stop working
    "drive.delete",                // third-party tokens dropped
    "workspaceMembership.delete",  // loses access and frees the billed seat
  ]) {
    assert.ok(kinds.includes(required), `offboarding did not perform ${required}`);
  }
  assert.ok(calls.some((c) => c.startsWith("user.update") && c.includes("deletedAt")));
});

test("offboarding an already-offboarded user is a no-op, so Clerk retries are safe", async () => {
  prisma.user.findUnique = (async () => ({ id: "u-1", deletedAt: new Date() })) as never;
  const calls = captureTransaction();

  await deleteUser("u-1");

  assert.deepEqual(calls, []);
});

test("an unknown user is a no-op", async () => {
  prisma.user.findUnique = (async () => null) as never;
  const calls = captureTransaction();

  await deleteUser("nobody");

  assert.deepEqual(calls, []);
});
