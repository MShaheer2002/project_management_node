import test from "node:test";
import assert from "node:assert/strict";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PRESIGN_SIGNABLE_HEADERS } from "./s3.js";

// Offline: presigning is pure signature math, so dummy credentials are enough
// and nothing leaves the machine. Mirrors audit check V-2.
const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "AKIAoffline", secretAccessKey: "offline-secret" },
});

const sign = (opts?: { signableHeaders?: Set<string> }) =>
  getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: "test-bucket",
      Key: "uploads/workspaces/ws-1/attachment/2026/09/file.png",
      ContentType: "image/png",
      ContentLength: 1,
    }),
    { expiresIn: 300, ...opts },
  );

const signedHeaders = (url: string) =>
  (new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");

test("the presigned PUT binds content-length and content-type (F-12)", async () => {
  const headers = signedHeaders(await sign({ signableHeaders: PRESIGN_SIGNABLE_HEADERS }));
  assert.ok(headers.includes("content-length"), `content-length not signed: ${headers.join(";")}`);
  assert.ok(headers.includes("content-type"), `content-type not signed: ${headers.join(";")}`);
});

test("the original form — no ContentLength, no signableHeaders — signed only host", async () => {
  // Reproduces the defect exactly as audited: the command carried Bucket, Key
  // and ContentType only, and the resulting URL constrained nothing but the
  // host, so any body size and any content type were accepted.
  const url = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: "b", Key: "k", ContentType: "image/png" }),
    { expiresIn: 300 },
  );
  assert.deepEqual(signedHeaders(url), ["host"]);
});

test("ContentLength alone is not enough — content-type still needs the explicit option", async () => {
  // The SDK signs content-length once it is on the command, but not
  // content-type, which is why PRESIGN_SIGNABLE_HEADERS names both.
  const headers = signedHeaders(await sign());
  assert.ok(headers.includes("content-length"));
  assert.equal(headers.includes("content-type"), false);
});

test("the signature changes with the declared length, so a URL is not reusable for a bigger body", async () => {
  const one = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: "b", Key: "k", ContentType: "image/png", ContentLength: 1 }),
    { expiresIn: 300, signableHeaders: PRESIGN_SIGNABLE_HEADERS },
  );
  const many = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: "b", Key: "k", ContentType: "image/png", ContentLength: 20_000_000 }),
    { expiresIn: 300, signableHeaders: PRESIGN_SIGNABLE_HEADERS },
  );
  assert.notEqual(
    new URL(one).searchParams.get("X-Amz-Signature"),
    new URL(many).searchParams.get("X-Amz-Signature"),
  );
});
