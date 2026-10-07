/* Creates the bucket if it is missing (local rehearsal, a fresh MinIO). Private — no policy is set, so nothing in it is
   readable without credentials; the API streams every file itself. Usage (tools image): node infra/s3-bucket.mjs */
const { AwsClient } = await import(new URL("../apps/api/node_modules/aws4fetch/dist/aws4fetch.esm.mjs", import.meta.url).href);
const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION } = process.env;
const aws = new AwsClient({ accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY, service: "s3", region: S3_REGION || "us-east-1" });
const url = `${S3_ENDPOINT.replace(/\/+$/, "")}/${S3_BUCKET}`;
const head = await aws.fetch(url, { method: "HEAD" });
if (head.ok) { console.log(`bucket ${S3_BUCKET} exists`); process.exit(0); }
const r = await aws.fetch(url, { method: "PUT" });
if (!r.ok) { console.error(`bucket ${S3_BUCKET}: HTTP ${r.status} ${await r.text()}`); process.exit(1); }
console.log(`bucket ${S3_BUCKET} created (private)`);
