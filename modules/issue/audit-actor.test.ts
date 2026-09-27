import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../shared/utils/prisma.js";
import { deleteIssue } from "./issue.service.js";
import { removeTeamMember } from "../team/team-membership.service.js";

/** Records the actorId of every activity row written, without a DB. */
function captureActors() {
  const actors: string[] = [];
  prisma.activity.create = (async ({ data }: { data: { actorId: string } }) => { actors.push(data.actorId); }) as never;
  return actors;
}

test("deleting an issue is attributed to the deleting admin, not the creator (F-33)", async () => {
  const actors = captureActors();
  prisma.issue.findFirst = (async () => ({ id: "i-1", creatorId: "creator" })) as never;
  prisma.issue.delete = (async () => ({})) as never;

  await deleteIssue("ws-1", { userId: "admin", role: "ADMIN" } as never, "i-1");

  assert.deepEqual(actors, ["admin"]);
});

test("removing a team member is attributed to the remover, not the removed member (F-33)", async () => {
  const actors = captureActors();
  prisma.$transaction = (async (fn: (tx: unknown) => unknown) => fn({
    team: { findFirst: async () => ({ leadId: "lead", name: "Team" }) },
    teamMembership: { findUnique: async () => ({ userId: "removed" }), delete: async () => ({}) },
  })) as never;
  // No membership → createNotification returns before touching anything else.
  prisma.workspaceMembership.findUnique = (async () => null) as never;

  await removeTeamMember("ws-1", "t-1", "admin", "removed").catch(() => {});

  assert.equal(actors[0], "admin");
});
