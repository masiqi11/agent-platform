import { randomBytes } from "node:crypto";

/** Time-ordered, type-prefixed ids (§6.2): <prefix>_<12 hex ms><10 base32 random>. */
const B32 = "0123456789abcdefghjkmnpqrstvwxyz";
let clock: () => number = () => Date.now();
let lastMs = 0;
let counter = 0;
export function setIdClock(fn: () => number) {
  clock = fn;
}
export function newId(prefix: string): string {
  let ms = clock();
  if (ms <= lastMs) {
    counter++;
    ms = lastMs;
  } else {
    counter = 0;
    lastMs = ms;
  }
  const time = ms.toString(16).padStart(12, "0") + counter.toString(16).padStart(3, "0");
  const rnd = randomBytes(8);
  let r = "";
  for (const b of rnd) r += B32[b & 31];
  return `${prefix}_${time}${r}`;
}
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
