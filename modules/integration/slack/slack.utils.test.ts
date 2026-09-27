import test from "node:test";
import assert from "node:assert/strict";
import { findIntegrationForTeam } from "./slack.utils.js";

const tenantA = { workspaceId: "ws-a", providerMeta: { team: { id: "T-A" } } };
const tenantB = { workspaceId: "ws-b", providerMeta: { team: { id: "T-B" } } };
const all = [tenantA, tenantB];

test("a slash command resolves to its own tenant", () => {
  assert.equal(findIntegrationForTeam(all, "T-B"), tenantB);
});

test("an unmatched Slack team resolves to nothing, never another tenant (F-03)", () => {
  // A tenant that disconnected in Trussen still has the app installed, so Slack
  // keeps signing their requests. Falling back to integrations[0] would hand
  // them ws-a's issues.
  assert.equal(findIntegrationForTeam(all, "T-DISCONNECTED"), undefined);
  assert.equal(findIntegrationForTeam(all, ""), undefined);
  assert.equal(findIntegrationForTeam([{ workspaceId: "ws-a", providerMeta: null }], "T-A"), undefined);
});
