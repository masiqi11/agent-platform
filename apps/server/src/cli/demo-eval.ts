/**
 * KB-补6: the demo projects' evaluation set (30 questions, 演示数据). Each question lists the paths
 * an answer must cite; recall@5 over these is the regression signal for retrieval / chunking /
 * prompt changes. Run: `bun run kb:eval` (or the s7-eval test in CI).
 */
export interface EvalItem {
  repo: "payments" | "billing";
  question: string;
  expect: string[];
  tags?: string[];
}

export const DEMO_EVAL: EvalItem[] = [
  { repo: "payments", question: "调用上游网关的超时时间在哪里配置", expect: ["src/gateway.ts"] },
  { repo: "payments", question: "上游支付网关多久会断开连接", expect: ["src/gateway.ts", "docs/runbook.md"] },
  { repo: "payments", question: "callGateway 是怎么实现超时的", expect: ["src/gateway.ts"] },
  { repo: "payments", question: "GatewayTimeout 错误在哪里抛出", expect: ["src/gateway.ts"] },
  { repo: "payments", question: "下单接口在哪个文件", expect: ["src/orders.ts"] },
  { repo: "payments", question: "下单金额为零会怎样", expect: ["src/orders.ts", "test/orders.test.ts"] },
  { repo: "payments", question: "placeOrder 如何调用网关", expect: ["src/orders.ts"] },
  { repo: "payments", question: "支付回调如何验签", expect: ["src/callback.ts"] },
  { repo: "payments", question: "verifySignature 用的什么算法", expect: ["src/callback.ts"] },
  { repo: "payments", question: "重复的支付回调怎么处理，幂等吗", expect: ["src/callback.ts"] },
  { repo: "payments", question: "退款金额校验规则", expect: ["src/refund.ts"] },
  { repo: "payments", question: "累计退款超过支付金额会怎样", expect: ["src/refund.ts", "docs/runbook.md"] },
  { repo: "payments", question: "调用网关失败最多重试几次", expect: ["src/config.ts"] },
  { repo: "payments", question: "每天什么时候和上游对账", expect: ["src/config.ts", "docs/runbook.md"] },
  { repo: "payments", question: "回调去重记录保留多久", expect: ["src/config.ts"] },
  { repo: "payments", question: "下单超时怎么排查", expect: ["docs/runbook.md"] },
  { repo: "payments", question: "订单已支付但状态没更新怎么办", expect: ["docs/runbook.md"] },
  { repo: "payments", question: "超时的测试用例在哪", expect: ["test/gateway.test.ts"] },
  { repo: "billing", question: "超时相关的计费逻辑在哪个文件", expect: ["src/payments-client.ts", "docs/timeouts.md"] },
  { repo: "billing", question: "计费调用支付服务的超时是多少", expect: ["src/payments-client.ts", "docs/timeouts.md"] },
  { repo: "billing", question: "计费调用支付失败重试几次", expect: ["src/payments-client.ts", "docs/timeouts.md"] },
  { repo: "billing", question: "chargeInvoice 失败后账单是什么状态", expect: ["src/payments-client.ts"] },
  { repo: "billing", question: "账单总额怎么计算", expect: ["src/invoice.ts"] },
  { repo: "billing", question: "total 函数在哪", expect: ["src/invoice.ts"] },
  { repo: "billing", question: "增值税税率默认多少", expect: ["src/tax.ts"] },
  { repo: "billing", question: "税额如何计算", expect: ["src/tax.ts"] },
  { repo: "billing", question: "分转元用什么舍入方式", expect: ["src/rounding.ts"] },
  { repo: "billing", question: "银行家舍入的实现", expect: ["src/rounding.ts"] },
  { repo: "billing", question: "支付网关超时约定是什么", expect: ["docs/timeouts.md"] },
  { repo: "billing", question: "计费服务是做什么的", expect: ["README.md"] },
];
