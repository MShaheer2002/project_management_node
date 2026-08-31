import test from "node:test";
import assert from "node:assert/strict";
import { connectionMatchesIdentity } from "./ai-connection.service.js";

test("PAT identity matches only the connection with the same apiKeyId", () => {
  assert.equal(
    connectionMatchesIdentity({ apiKeyId: "key_1", oauthClientId: null }, { type: "pat", apiKeyId: "key_1" }),
    true,
  );
  assert.equal(
    connectionMatchesIdentity({ apiKeyId: "key_1", oauthClientId: null }, { type: "pat", apiKeyId: "key_2" }),
    false,
  );
});

test("OAuth identity matches only the connection with the same oauthClientId", () => {
  assert.equal(
    connectionMatchesIdentity({ apiKeyId: null, oauthClientId: "client_1" }, { type: "oauth", oauthClientId: "client_1" }),
    true,
  );
  assert.equal(
    connectionMatchesIdentity({ apiKeyId: null, oauthClientId: "client_1" }, { type: "oauth", oauthClientId: "client_2" }),
    false,
  );
});

test("two null-apiKeyId OAuth connections never match a PAT identity, and vice versa", () => {
  // Regression guard: apiKeyId is null on every OAuth connection, so a naive
  // `connection.apiKeyId !== input.apiKeyId` comparison would wrongly treat
  // any two OAuth connections as interchangeable. Matching must be scoped to
  // the identity's own type.
  assert.equal(
    connectionMatchesIdentity({ apiKeyId: null, oauthClientId: "client_1" }, { type: "pat", apiKeyId: "key_1" }),
    false,
  );
  assert.equal(
    connectionMatchesIdentity({ apiKeyId: "key_1", oauthClientId: null }, { type: "oauth", oauthClientId: "client_1" }),
    false,
  );
});
