import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** AES-256-GCM credential vault with key versions (§14.3, ADM-补1). */
export function createVault(masterKeys: Record<number, string>, currentVersion: number) {
  const keyFor = (v: number) => {
    const mk = masterKeys[v];
    if (!mk) throw new Error(`master key version ${v} unavailable`);
    return createHash("sha256").update(`ap-vault:${mk}`).digest();
  };
  return {
    currentVersion,
    encrypt(plaintext: string): { ciphertext: string; keyVersion: number } {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", keyFor(currentVersion), iv);
      const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      const tag = c.getAuthTag();
      return { ciphertext: [iv, tag, ct].map((b) => b.toString("base64")).join("."), keyVersion: currentVersion };
    },
    decrypt(ciphertext: string, keyVersion: number): string {
      const [iv, tag, ct] = ciphertext.split(".").map((s) => Buffer.from(s, "base64"));
      if (!iv || !tag || !ct) throw new Error("malformed ciphertext");
      const d = createDecipheriv("aes-256-gcm", keyFor(keyVersion), iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    },
  };
}
export type Vault = ReturnType<typeof createVault>;

export const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const hmacHex = (key: string, s: string) => createHmac("sha256", key).update(s).digest("hex");
export function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) {
    timingSafeEqual(A, A);
    return false;
  }
  return timingSafeEqual(A, B);
}
