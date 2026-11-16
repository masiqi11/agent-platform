/**
 * Demo repositories for `bun run seed` and the S5/S6 end-to-end tests (all labelled 演示数据).
 * Kept as file maps (not real files) so the server's own `bun test` never picks the demo tests up.
 *
 * payments: a reproducible timeout defect — the client waits 30 s for an upstream gateway that
 * drops the connection at 5 s, so requests hang and then fail. `bun test` fails until fixed.
 */
export const PAYMENTS_REPO: Record<string, string> = {
  "README.md": `# payments（演示数据）

支付服务：调用上游支付网关下单、处理回调。

- \`bun test\` 运行测试
- 已知问题：近期下单接口偶发超时（见 src/gateway.ts）
`,
  "src/gateway.ts": `/** 上游支付网关在 5 秒后主动断开连接。 */
export const UPSTREAM_GATEWAY_TIMEOUT_MS = 5_000;

export const GATEWAY_CALL_TIMEOUT_MS = 30_000; // FIXME: 上游网关 5s 就断开，这里却等 30s，请求挂起后才失败；应改为 3_000

export class GatewayTimeout extends Error {}

/** Calls the gateway, failing fast once our own timeout elapses. */
export async function callGateway<T>(fn: () => Promise<T>, timeoutMs = GATEWAY_CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GatewayTimeout(\`gateway timeout after \${timeoutMs}ms\`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
`,
  "src/orders.ts": `import { callGateway } from "./gateway";

export interface Order {
  id: string;
  amountCents: number;
}

export async function placeOrder(order: Order, gateway: (o: Order) => Promise<{ ok: boolean }>) {
  if (order.amountCents <= 0) throw new Error("金额必须为正数");
  return callGateway(() => gateway(order));
}
`,
  "test/gateway.test.ts": `import { describe, expect, test } from "bun:test";
import { GATEWAY_CALL_TIMEOUT_MS, UPSTREAM_GATEWAY_TIMEOUT_MS, callGateway } from "../src/gateway";

describe("gateway timeout", () => {
  test("our timeout is shorter than the upstream gateway's", () => {
    expect(GATEWAY_CALL_TIMEOUT_MS).toBeLessThan(UPSTREAM_GATEWAY_TIMEOUT_MS);
  });
  test("a hung upstream call fails fast", async () => {
    const hang = () => new Promise<never>(() => {});
    await expect(callGateway(hang, 50)).rejects.toThrow("gateway timeout");
  });
});
`,
  "test/orders.test.ts": `import { expect, test } from "bun:test";
import { placeOrder } from "../src/orders";

test("rejects non-positive amounts", async () => {
  await expect(placeOrder({ id: "o1", amountCents: 0 }, async () => ({ ok: true }))).rejects.toThrow("金额必须为正数");
});
test("places an order", async () => {
  await expect(placeOrder({ id: "o2", amountCents: 100 }, async () => ({ ok: true }))).resolves.toEqual({ ok: true });
});
`,
};

export const BILLING_REPO: Record<string, string> = {
  "README.md": `# billing（演示数据）

计费服务：按订单生成账单。调用支付服务时使用与支付服务相同的超时约定（见 docs/timeouts.md）。
`,
  "docs/timeouts.md": `# 超时约定

- 支付网关：上游 5s 断开；调用方超时必须小于 5s（当前约定 3s）。
- 计费 → 支付：单次 3s，最多重试 1 次。
`,
  "src/invoice.ts": `export interface Line {
  sku: string;
  qty: number;
  unitCents: number;
}

export function total(lines: Line[]): number {
  return lines.reduce((n, l) => n + l.qty * l.unitCents, 0);
}
`,
  "test/invoice.test.ts": `import { expect, test } from "bun:test";
import { total } from "../src/invoice";

test("sums lines", () => {
  expect(total([{ sku: "a", qty: 2, unitCents: 150 }, { sku: "b", qty: 1, unitCents: 99 }])).toBe(399);
});
`,
};
