import test from "node:test";
import assert from "node:assert/strict";
import { integrationCoversRepo } from "./github.utils.js";

const tenant = { repos: ["acme/api", "acme/web"] };

test("an event is processed for the tenant that connected the repo", () => {
  assert.equal(integrationCoversRepo(tenant, "acme/api"), true);
  assert.equal(integrationCoversRepo(tenant, "ACME/Api"), true); // GitHub is case-insensitive
});

test("a repo another tenant owns is never processed (F-04)", () => {
  // The attack: a PR titled "VICTIM-12" opened in the attacker's own repo.
  // The signature is valid (shared secret), so only the repo check stops it.
  assert.equal(integrationCoversRepo(tenant, "attacker/evil"), false);
});

test("a missing or malformed repo list fails closed", () => {
  for (const meta of [null, undefined, {}, { repos: null }, { repos: "acme/api" }, { repos: [42] }]) {
    assert.equal(integrationCoversRepo(meta, "acme/api"), false);
  }
  assert.equal(integrationCoversRepo(tenant, ""), false);
});
