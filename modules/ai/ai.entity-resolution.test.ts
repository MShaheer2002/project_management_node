import test from "node:test";
import { afterEach } from "node:test";
import assert from "node:assert/strict";

import { parseEntityResolutionRequest, isEntityResolutionResult } from "./ai.entity-resolution.schemas.js";
import { resolveEntityReference } from "./ai.entity-resolution.js";
import { prisma } from "../../shared/utils/prisma.js";

type FindManyMock = (...args: Array<unknown>) => Promise<Array<unknown>>;

const originalProjectFindMany = prisma.project.findMany.bind(prisma.project);
const originalTeamFindMany = prisma.team.findMany.bind(prisma.team);
const originalEntityAliasFindMany = (prisma as any).entityAlias.findMany.bind((prisma as any).entityAlias);

function stubFindMany(target: unknown, value: Array<unknown>) {
  (target as { findMany: FindManyMock }).findMany = (async () => value) as FindManyMock;
}

afterEach(() => {
  prisma.project.findMany = originalProjectFindMany;
  prisma.team.findMany = originalTeamFindMany;
  (prisma as any).entityAlias.findMany = originalEntityAliasFindMany;
});

test("parses entity resolution requests with expected entity types", () => {
  const parsed = parseEntityResolutionRequest({
    workspaceId: "ws-1",
    userId: "user-1",
    userRole: "OWNER",
    rawMessage: "report on ridely",
    expectedEntityTypes: ["project", "team"],
    accessMode: "read",
    actionRisk: "low",
  });

  assert.deepEqual(parsed.expectedEntityTypes, ["project", "team"]);
  assert.equal(parsed.entityType, undefined);
});

test("requires either entityType or expectedEntityTypes", () => {
  assert.throws(
    () => parseEntityResolutionRequest({
      workspaceId: "ws-1",
      userId: "user-1",
      userRole: "OWNER",
      rawMessage: "report on ridely",
    }),
    /entityType or expectedEntityTypes/i,
  );
});

test("recognizes valid entity resolution result envelopes", () => {
  assert.equal(isEntityResolutionResult({
    status: "resolved",
    entityType: "project",
    reason: "exact name match",
  }), true);
});

test("uses current context safely when no explicit entity mention exists", async () => {
  stubFindMany(prisma.project, [{ id: "p1", name: "Ridely App" }]);
  stubFindMany((prisma as any).entityAlias, []);

  const result = await resolveEntityReference({
    workspaceId: "ws-1",
    userId: "user-1",
    userRole: "MEMBER",
    rawMessage: "how is it going?",
    expectedEntityTypes: ["project"],
    accessMode: "read",
    actionRisk: "low",
    currentContext: { projectId: "p1" },
    enableEmbeddings: false,
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.match?.id, "p1");
});

test("treats ambiguous aliases as ambiguous-by-construction", async () => {
  stubFindMany(prisma.team, [
    { id: "team-1", name: "Platform Team" },
    { id: "team-2", name: "Core Team" },
  ]);
  stubFindMany((prisma as any).entityAlias, [
    { entityId: "team-1", alias: "Core" },
    { entityId: "team-2", alias: "Core" },
  ]);

  const result = await resolveEntityReference({
    workspaceId: "ws-1",
    userId: "user-1",
    userRole: "OWNER",
    rawMessage: "core",
    mention: "core",
    expectedEntityTypes: ["team"],
    accessMode: "read",
    actionRisk: "low",
    enableEmbeddings: false,
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates?.length, 2);
});

test("resolves multilingual and accented aliases safely", async () => {
  stubFindMany(prisma.project, [{ id: "p1", name: "USingle2 App" }]);
  stubFindMany((prisma as any).entityAlias, [
    { entityId: "p1", alias: "رائیڈلی", normalized: "رایڈلی", locale: "ur" },
    { entityId: "p1", alias: "مشروع ريدلي", normalized: "مشروع ريدلي", locale: "ar" },
    { entityId: "p1", alias: "रिडली", normalized: "रिडली", locale: "hi" },
    { entityId: "p1", alias: "瑞德利", normalized: "瑞德利", locale: "zh" },
    { entityId: "p1", alias: "リドリー", normalized: "リドリー", locale: "ja" },
    { entityId: "p1", alias: "리들리", normalized: "리들리", locale: "ko" },
    { entityId: "p1", alias: "Ридели", normalized: "ридели", locale: "ru" },
    { entityId: "p1", alias: "Café Ridély", normalized: "cafe ridely", locale: "fr" },
  ]);

  const mentions = ["رائیڈلی", "مشروع ريدلي", "रिडली", "瑞德利", "リドリー", "리들리", "Ридели", "Cafe Ridely"];

  for (const mention of mentions) {
    const result = await resolveEntityReference({
      workspaceId: "ws-1",
      userId: "user-1",
      userRole: "OWNER",
      rawMessage: mention,
      mention,
      expectedEntityTypes: ["project"],
      accessMode: "read",
      actionRisk: "low",
      enableEmbeddings: false,
    });

    assert.equal(result.status, "resolved");
    assert.equal(result.match?.id, "p1");
  }
});

test("resolves a clear winner across multiple allowed entity types", async () => {
  stubFindMany(prisma.project, [{ id: "p1", name: "Ridely App" }]);
  stubFindMany(prisma.team, [{ id: "t1", name: "Core Team" }]);
  stubFindMany((prisma as any).entityAlias, [
    { entityId: "p1", alias: "Ridely", normalized: "ridely", locale: "en" },
  ]);

  const result = await resolveEntityReference({
    workspaceId: "ws-1",
    userId: "user-1",
    userRole: "OWNER",
    rawMessage: "ridely",
    mention: "ridely",
    expectedEntityTypes: ["project", "team"],
    accessMode: "read",
    actionRisk: "low",
    enableEmbeddings: false,
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.entityType, "project");
  assert.equal(result.match?.id, "p1");
});

test("resolves an exact entity name contained inside a broader sentence", async () => {
  stubFindMany(prisma.project, [{ id: "p1", name: "Telegrant" }]);
  stubFindMany((prisma as any).entityAlias, []);

  const result = await resolveEntityReference({
    workspaceId: "ws-1",
    userId: "user-1",
    userRole: "OWNER",
    rawMessage: "How is Telegrant doing?",
    expectedEntityTypes: ["project"],
    accessMode: "read",
    actionRisk: "low",
    enableEmbeddings: false,
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.match?.id, "p1");
  assert.ok((result.confidence ?? 0) >= 0.9);
});

test("asks for clarification when project and team candidates are too close across types", async () => {
  stubFindMany(prisma.project, [{ id: "p1", name: "Core" }]);
  stubFindMany(prisma.team, [{ id: "t1", name: "Core" }]);
  stubFindMany((prisma as any).entityAlias, []);

  const result = await resolveEntityReference({
    workspaceId: "ws-1",
    userId: "user-1",
    userRole: "OWNER",
    rawMessage: "core",
    mention: "core",
    expectedEntityTypes: ["project", "team"],
    accessMode: "read",
    actionRisk: "low",
    enableEmbeddings: false,
  });

  assert.equal(result.status, "ambiguous");
  assert.ok((result.candidates?.length ?? 0) >= 2);
  assert.match(result.candidates?.[0]?.name ?? "", /\((project|team)\)/i);
});

test("does not cross-resolve into an unrelated entity type", async () => {
  stubFindMany(prisma.project, [{ id: "p1", name: "Ridely App" }]);
  stubFindMany((prisma as any).entityAlias, []);

  const result = await resolveEntityReference({
    workspaceId: "ws-1",
    userId: "user-1",
    userRole: "OWNER",
    rawMessage: "Unknown Shaheer",
    mention: "Unknown Shaheer",
    expectedEntityTypes: ["project"],
    accessMode: "read",
    actionRisk: "low",
    enableEmbeddings: false,
  });

  assert.equal(result.status, "not_found");
});
