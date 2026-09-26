import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../app/generated/prisma/client.js";
import { moveIssuesToStatus, workspaceWorkflowIssueScope } from "./bulk-status.js";

const status = (key: string, isFinal: boolean) => ({ key, isFinal }) as never;

test("workspace scope excludes only projects with their own workflow (F-34)", async () => {
  const db = {
    project: {
      findMany: async () => [
        { id: "inherit", customStatuses: null },           // never set
        { id: "cleared", customStatuses: Prisma.JsonNull }, // override cleared
        { id: "empty", customStatuses: [] },
        { id: "own", customStatuses: [{ key: "review" }] },
      ],
    },
  } as never;

  assert.deepEqual(await workspaceWorkflowIssueScope(db, "ws"), { workspaceId: "ws", projectId: { notIn: ["own"] } });
});

test("workspace scope is the whole workspace when no project overrides", async () => {
  const db = { project: { findMany: async () => [{ id: "a", customStatuses: null }] } } as never;
  assert.deepEqual(await workspaceWorkflowIssueScope(db, "ws"), { workspaceId: "ws" });
});

function recordingDb() {
  const calls: Array<{ op: string; args: any }> = [];
  const db = {
    issueApproval: { deleteMany: async (args: unknown) => { calls.push({ op: "approval.deleteMany", args }); } },
    issue: { updateMany: async (args: unknown) => { calls.push({ op: "issue.updateMany", args }); } },
  } as never;
  return { db, calls };
}

test("bulk move keeps every write inside the scope and clears approvals like a single move", async () => {
  const { db, calls } = recordingDb();
  const scope = { projectId: "p1" };

  await moveIssuesToStatus(db, scope, "review", status("in-progress", false));

  const moving = { AND: [scope, { status: "review" }] };
  assert.deepEqual(calls, [
    // Only this scope's approvals — a project merge used to wipe the key workspace-wide.
    { op: "approval.deleteMany", args: { where: { statusKey: { in: ["review", "in-progress"] }, issue: moving } } },
    { op: "issue.updateMany", args: { where: moving, data: { status: "in-progress", completedAt: null } } },
  ]);
});

test("moving into a final status stamps only issues not already completed", async () => {
  const { db, calls } = recordingDb();

  await moveIssuesToStatus(db, { projectId: "p1" }, "closed", status("done", true));

  const updates = calls.filter((call) => call.op === "issue.updateMany").map((call) => call.args);
  assert.deepEqual(updates[0].where.AND.at(-1), { completedAt: null });
  assert.ok(updates[0].data.completedAt instanceof Date);
  assert.deepEqual(updates[1].data, { status: "done" }, "existing completedAt must not be overwritten");
});
