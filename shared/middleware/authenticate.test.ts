import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../utils/prisma.js";
import { isAllowedTokenParty } from "../utils/allowed-origin.js";
import { authenticate } from "./authenticate.js";

test("only tokens made for our own site are accepted (N-12)", () => {
  for (const azp of ["https://trussen.app", "https://acme.trussen.app", undefined, null, ""]) {
    assert.equal(isAllowedTokenParty(azp, "production"), true, String(azp));
  }
  for (const azp of ["https://evil.test", "https://trussen.app.evil.test", "http://acme.trussen.app", "https://eviltrussen.app", "http://localhost:3000", 42]) {
    assert.equal(isAllowedTokenParty(azp, "production"), false, String(azp));
  }
  assert.equal(isAllowedTokenParty("http://acme.localhost:3000", "development"), true, "local dev still works");
});

// clerkMiddleware puts req.auth on the request; this fakes a verified session.
const request = (headers: Record<string, string>, azp?: string) => ({
  headers,
  auth: () => ({ tokenType: "session_token", userId: "user_1", sessionClaims: azp ? { azp } : {}, isAuthenticated: true }),
}) as never;
const run = (req: never) => new Promise<{ status?: number; user?: unknown }>((resolve) => {
  authenticate(req, {} as never, (error?: any) => resolve(error ? { status: error.statusCode } : { user: (req as any).user }));
});

test("the login cookie alone is not enough; the header token is required", async () => {
  (prisma.user as any).findUnique = async () => ({ id: "user_1", email: "a@x.test", name: "A", deletedAt: null });

  assert.equal((await run(request({ cookie: "__session=eyJ..." }, "https://acme.trussen.app"))).status, 401, "cookie only");
  assert.equal((await run(request({ authorization: "Basic abc" }, "https://acme.trussen.app"))).status, 401);
  assert.equal((await run(request({ authorization: "Bearer t" }, "https://evil.test"))).status, 401, "token made for another site");

  const ok = await run(request({ authorization: "Bearer t" }, process.env.NODE_ENV === "production" ? "https://acme.trussen.app" : "http://localhost:3000"));
  assert.deepEqual(ok.user, { id: "user_1", email: "a@x.test", name: "A" });
  assert.deepEqual((await run(request({ authorization: "Bearer t" }, "https://acme.trussen.app"))).user, { id: "user_1", email: "a@x.test", name: "A" });
});
