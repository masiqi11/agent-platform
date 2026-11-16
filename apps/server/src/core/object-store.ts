import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { sha256Hex } from "./crypto";

export interface ObjectStore {
  put(key: string, data: Buffer | string): Promise<{ uri: string; sha256: string; size: number }>;
  get(uri: string): Promise<Buffer>;
  exists(uri: string): Promise<boolean>;
}

/** Local-directory object store; keys are validated to stay under the root (§14.5 path rule). */
export function createLocalObjectStore(root: string): ObjectStore {
  const abs = (key: string) => {
    const p = resolve(root, key.replace(/^local:\/\//, ""));
    if (!p.startsWith(resolve(root) + sep)) throw new Error("object key escapes store root");
    return p;
  };
  return {
    async put(key, data) {
      const p = abs(key);
      await mkdir(dirname(p), { recursive: true });
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      await Bun.write(p, buf);
      return { uri: `local://${key}`, sha256: sha256Hex(buf), size: buf.length };
    },
    async get(uri) {
      return readFile(abs(uri));
    },
    async exists(uri) {
      try {
        await stat(abs(uri));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** S3-compatible store using Bun's built-in S3 client. 已实现、未经真机验证. */
export function createS3ObjectStore(cfg: { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string }): ObjectStore {
  const client = new Bun.S3Client({ endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket, accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey });
  return {
    async put(key, data) {
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      await client.write(key, buf);
      return { uri: `s3://${cfg.bucket}/${key}`, sha256: sha256Hex(buf), size: buf.length };
    },
    async get(uri) {
      const key = uri.replace(`s3://${cfg.bucket}/`, "");
      return Buffer.from(await client.file(key).arrayBuffer());
    },
    async exists(uri) {
      return client.file(uri.replace(`s3://${cfg.bucket}/`, "")).exists();
    },
  };
}
