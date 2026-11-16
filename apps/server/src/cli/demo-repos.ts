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
  "src/callback.ts": `import { createHmac, timingSafeEqual } from "node:crypto";

/** 支付回调：上游网关异步通知支付结果。必须先验签，再按订单号幂等处理。 */
export interface CallbackPayload {
  orderId: string;
  status: "paid" | "failed";
  amountCents: number;
}

/** 回调验签：HMAC-SHA256(body)，与上游约定的商户密钥。 */
export function verifySignature(body: string, signature: string, merchantSecret: string): boolean {
  const expected = createHmac("sha256", merchantSecret).update(body).digest("hex");
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const processed = new Set<string>();

/** 幂等：同一订单号的重复回调只处理一次（上游会重试通知）。 */
export function handleCallback(p: CallbackPayload): "processed" | "duplicate" {
  if (processed.has(p.orderId)) return "duplicate";
  processed.add(p.orderId);
  return "processed";
}
`,
  "src/refund.ts": `/** 退款：只能对已支付订单退款，且累计退款金额不能超过支付金额。 */
export interface RefundRequest {
  orderId: string;
  paidCents: number;
  refundedCents: number;
  amountCents: number;
}

export function validateRefund(r: RefundRequest): string | null {
  if (r.amountCents <= 0) return "退款金额必须为正数";
  if (r.refundedCents + r.amountCents > r.paidCents) return "累计退款金额超过支付金额";
  return null;
}
`,
  "src/config.ts": `/** 支付服务配置：重试与对账。 */
export const PAYMENT_RETRY_LIMIT = 2; // 调用上游网关失败后的最大重试次数
export const RECONCILE_CRON = "0 2 * * *"; // 每天凌晨 2 点与上游对账
export const CALLBACK_DEDUP_TTL_HOURS = 72; // 回调去重记录保留时长
`,
  "docs/runbook.md": `# 支付服务运维手册（演示数据）

## 下单超时
现象：下单接口长时间挂起后失败。先看 src/gateway.ts 的调用超时是否小于上游网关超时（5s）。

## 回调失败
现象：订单已支付但状态未更新。检查回调验签（src/callback.ts）与商户密钥是否轮换。

## 对账差异
每天凌晨 2 点对账（src/config.ts 的 RECONCILE_CRON）。差异单需人工复核后补单或退款。

## 退款失败
常见原因是累计退款超过支付金额，见 src/refund.ts。
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
  "src/payments-client.ts": `/**
 * 计费服务调用支付服务的客户端：超时相关的计费逻辑都在这里。
 * 单次调用超时 3s（必须小于支付网关的 5s），失败最多重试 1 次；仍失败则账单记为「待支付」。
 */
export const PAYMENTS_CALL_TIMEOUT_MS = 3_000;
export const PAYMENTS_RETRY = 1;

export async function chargeInvoice(invoiceId: string, call: (id: string) => Promise<boolean>): Promise<"paid" | "pending"> {
  for (let attempt = 0; attempt <= PAYMENTS_RETRY; attempt++) {
    try {
      if (await call(invoiceId)) return "paid";
    } catch {
      // 超时或失败：重试一次
    }
  }
  return "pending";
}
`,
  "src/tax.ts": `/** 税额：按税率计算，结果以分为单位。增值税默认 6%。 */
export const DEFAULT_VAT_RATE = 0.06;

export function taxCents(netCents: number, rate = DEFAULT_VAT_RATE): number {
  return Math.round(netCents * rate);
}
`,
  "src/rounding.ts": `/** 金额取整：分转元时使用银行家舍入（四舍六入五成双），避免对账误差累积。 */
export function bankersRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function centsToYuan(cents: number): number {
  return bankersRound(cents) / 100;
}
`,
  "test/invoice.test.ts": `import { expect, test } from "bun:test";
import { total } from "../src/invoice";

test("sums lines", () => {
  expect(total([{ sku: "a", qty: 2, unitCents: 150 }, { sku: "b", qty: 1, unitCents: 99 }])).toBe(399);
});
`,
};
