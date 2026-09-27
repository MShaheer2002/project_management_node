import test from "node:test";
import assert from "node:assert/strict";
import { allowedSharingLevels, applyDriveSharing, assertSharingAllowed, companyDomainOf } from "./drive.sharing.js";

test("personal Google accounts have no company to share with", () => {
  assert.equal(companyDomainOf("someone@gmail.com"), null);
  assert.equal(companyDomainOf("Someone@GoogleMail.com"), null);
  assert.equal(companyDomainOf("ana@Acme.com"), "acme.com");
  assert.equal(companyDomainOf(null), null);
});

test("the uploader is only offered what they may choose (F-39)", () => {
  assert.deepEqual(allowedSharingLevels("a@gmail.com", false), ["PRIVATE"]);
  assert.deepEqual(allowedSharingLevels("a@acme.com", false), ["PRIVATE", "COMPANY"]);
  assert.deepEqual(allowedSharingLevels("a@acme.com", true), ["PRIVATE", "COMPANY", "PUBLIC"]);
  assert.throws(() => assertSharingAllowed("PUBLIC", "a@acme.com", false), /turned off/);
  assert.throws(() => assertSharingAllowed("COMPANY", "a@gmail.com", true), /company/);
});

function stubDrive(options: { refuse?: boolean; existing?: Array<{ id: string; type: string }> } = {}) {
  const calls: string[] = [];
  const perms = [...(options.existing ?? [])];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${new URL(url).pathname}`);
    if (method === "GET") return new Response(JSON.stringify({ permissions: perms }));
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response("{}", { status: options.refuse ? 403 : 200 });
  }) as never;
  return calls;
}

test("private adds nothing; a fresh upload skips the permission lookup", async () => {
  const calls = stubDrive();
  assert.deepEqual(await applyDriveSharing("t", "f1", "PRIVATE", "a@acme.com", { freshUpload: true }), { sharing: "PRIVATE", notice: null });
  assert.deepEqual(calls, []);
});

test("changing sharing removes existing link access before adding the new one", async () => {
  const calls = stubDrive({ existing: [{ id: "p1", type: "anyone" }, { id: "p2", type: "user" }] });
  const result = await applyDriveSharing("t", "f1", "COMPANY", "a@acme.com");
  assert.equal(result.sharing, "COMPANY");
  assert.deepEqual(calls, [
    "GET /drive/v3/files/f1/permissions",
    "DELETE /drive/v3/files/f1/permissions/p1",   // the public link — the person-level p2 is left alone
    "POST /drive/v3/files/f1/permissions",
  ]);
});

test("if Google refuses, the file stays private — never more open than asked", async () => {
  stubDrive({ refuse: true });
  const result = await applyDriveSharing("t", "f1", "PUBLIC", "a@acme.com", { freshUpload: true });
  assert.equal(result.sharing, "PRIVATE");
  assert.match(result.notice ?? "", /kept private/);
});
