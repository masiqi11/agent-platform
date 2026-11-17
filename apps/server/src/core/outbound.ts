import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DomainError } from "./errors";

/**
 * SSRF guard for requests the server makes on a user's behalf (§14.5): model provider base URLs,
 * the SCM API and git remotes. Refuses loopback, link-local, private and CGNAT addresses unless the
 * admin allowlisted them (OUTBOUND_ALLOW: hosts, host:port or CIDRs) — private deployments do
 * point at internal GitLab / Ollama, deliberately. Cloud metadata endpoints are refused always.
 * Names are resolved and every address checked, so a public name pointing inside is caught too.
 */
const METADATA = new Set(["169.254.169.254", "fd00:ec2::254", "100.100.100.200", "metadata.google.internal", "metadata"]);

function v4ToInt(ip: string) {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
function inV4(ip: string, cidr: string) {
  const [base, bits] = cidr.split("/");
  const b = Number(bits ?? 32);
  const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base!) & mask);
}
const INTERNAL_V4 = ["127.0.0.0/8", "0.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"];

/** Whether an address is internal (needs an allowlist entry). */
export function isInternalAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return INTERNAL_V4.some((c) => inV4(ip, c));
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::") return true;
    if (x.startsWith("::ffff:")) return isInternalAddress(x.slice(7));
    return /^(fe[89ab]|fc|fd)/.test(x); // link-local fe80::/10, unique-local fc00::/7
  }
  return false;
}

export function createOutboundGuard(o: { enforce: boolean; allow: string[] }) {
  const allowed = (host: string, port: string, ip?: string) =>
    o.allow.some((a) => {
      if (a.includes("/")) return Boolean(ip && isIP(ip) === 4 && isIP(a.split("/")[0]!) === 4 && inV4(ip, a));
      const [h, p] = a.split(/:(?=\d+$)/);
      return (h === host || h === ip) && (!p || p === port);
    });

  /** Throws when the URL's target is not allowed. */
  async function check(raw: string) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new DomainError("invalid", `地址无效：${raw.slice(0, 100)}`);
    }
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (METADATA.has(host)) throw new DomainError("forbidden", "不允许访问云元数据地址");
    if (!o.enforce) return;
    if (!["http:", "https:"].includes(u.protocol)) throw new DomainError("invalid", `不支持的协议：${u.protocol}`);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!ips.length) throw new DomainError("invalid", `无法解析主机 ${host}`);
    for (const ip of ips) {
      if (METADATA.has(ip)) throw new DomainError("forbidden", "不允许访问云元数据地址");
      if (isInternalAddress(ip) && !allowed(host, port, ip)) throw new DomainError("forbidden", `出站地址 ${host}（${ip}）是内网地址，未在 OUTBOUND_ALLOW 中放行`);
    }
  }

  /** A fetch that checks its target first (and refuses redirects that would skip the check). */
  function wrap(f: typeof fetch): typeof fetch {
    const guarded = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      await check(url);
      return f(input, o.enforce ? { ...init, redirect: "manual" } : init);
    };
    return Object.assign(guarded, { preconnect: fetch.preconnect }) as typeof fetch;
  }

  return { check, wrap, enforce: o.enforce };
}
export type OutboundGuard = ReturnType<typeof createOutboundGuard>;
