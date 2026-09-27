import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../../shared/utils/prisma.js";
import { executeTool } from "./tool-executor.js";
import { AI_TOOLS } from "./tool-definitions.js";

test("the AI cannot create API keys, even for an owner (F-45)", async () => {
  let created = false;
  prisma.apiKey.create = (async () => { created = true; return {}; }) as never;

  const result = await executeTool("create_api_key", { name: "CI" }, { workspaceId: "ws", userId: "u1", userRole: "OWNER" } as never);

  assert.equal(result.success, false);
  assert.match(JSON.stringify(result), /Settings/, "points to Settings");
  assert.equal(created, false, "no key was created, so no secret can reach the model");
});

test("the tool isn't offered to the model", () => {
  assert.equal(AI_TOOLS.some((tool) => tool.function.name === "create_api_key"), false);
});
