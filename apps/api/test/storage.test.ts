/* Staging (week 2): S3Storage against a real S3-compatible store (MinIO). Runs when S3_TEST_ENDPOINT is set (CI has a
   MinIO service; locally: a MinIO container), else skipped — loudly. Write-once, read back, missing → null, keys
   checked, and the bucket refuses anonymous reads (no public bucket; the API streams every file itself). */
import { randomBytes } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { beforeAll, describe, expect, it } from "vitest";
import { S3Storage, storageFromEnv } from "../src/adapters/storage.js";

const endpoint = process.env.S3_TEST_ENDPOINT;
if (!endpoint) console.warn("storage.test: S3_TEST_ENDPOINT not set — S3Storage tests SKIPPED");
const creds = { accessKeyId: process.env.S3_TEST_ACCESS_KEY ?? "setutest", secretAccessKey: process.env.S3_TEST_SECRET_KEY ?? "setutestsecret" };
const bucket = `setu-test-${randomBytes(4).toString("hex")}`;

describe.runIf(endpoint)("S3Storage (MinIO)", () => {
  let s: S3Storage;
  beforeAll(async () => {
    const aws = new AwsClient({ ...creds, service: "s3", region: "us-east-1" });
    const r = await aws.fetch(`${endpoint}/${bucket}`, { method: "PUT" });
    expect(r.status, await r.text()).toBe(200);
    s = new S3Storage({ endpoint: endpoint!, region: "us-east-1", bucket, ...creds, pathStyle: true });
  });
  it("writes once and reads back the same bytes; a missing key is null; a second write of the key is refused", async () => {
    const key = `tenants/t_test/receipts/r1/0-a5-both-${randomBytes(3).toString("hex")}.pdf`;
    const bytes = new Uint8Array(randomBytes(4096));
    await s.put(key, bytes, "application/pdf");
    expect(Buffer.from((await s.get(key))!)).toEqual(Buffer.from(bytes));
    expect(await s.get(`${key}.nope`)).toBeNull();
    await expect(s.put(key, new Uint8Array([1, 2, 3]), "application/pdf")).rejects.toThrow(/already exists/);
    expect(Buffer.from((await s.get(key))!)).toEqual(Buffer.from(bytes)); // the first copy stands
  });
  it("refuses keys the API never makes, and the bucket is not readable without credentials", async () => {
    await expect(s.put("../etc/passwd", new Uint8Array([1]), "text/plain")).rejects.toThrow(/invalid key/);
    await expect(s.get("a//b")).rejects.toThrow(/invalid key/);
    const key = `tenants/t_test/x/${randomBytes(3).toString("hex")}.pdf`;
    await s.put(key, new Uint8Array([7]), "application/pdf");
    const anon = await fetch(`${endpoint}/${bucket}/${key}`);
    expect(anon.status).toBe(403);
  });
  it("STORAGE=s3 builds an S3Storage from the environment; a missing setting is named", () => {
    expect(storageFromEnv({ STORAGE: "s3", S3_ENDPOINT: endpoint, S3_BUCKET: bucket, S3_ACCESS_KEY: "a", S3_SECRET_KEY: "b" }).name).toBe("s3");
    expect(() => storageFromEnv({ STORAGE: "s3", S3_ENDPOINT: endpoint })).toThrow(/S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY/);
    expect(storageFromEnv({ STORAGE_DIR: "/tmp/x" }).name).toBe("local-folder");
  });
});
