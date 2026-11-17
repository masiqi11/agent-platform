import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";

export type Engine = "builtin" | "claude-code" | "codex" | "opencode" | "pi";
export type Reasoning = "low" | "high" | "max";

const modelOptionsQuery = (projectId: string) => ({
  queryKey: ["model-options", projectId] as const,
  queryFn: () => unwrap(api.api.v1.projects({ id: projectId })["model-options"].get()),
});
type Options = Awaited<ReturnType<ReturnType<typeof modelOptionsQuery>["queryFn"]>>;

/** Generic monograms (not product logos) so the tabs stay scannable at a glance. */
const MARK: Record<Engine, string> = { builtin: "内", "claude-code": "CC", codex: "CX", opencode: "OC", pi: "pi" };
const API_LABEL: Record<string, string> = { chat: "Chat Completions", responses: "Responses", messages: "Anthropic Messages" };
const REASONING: Array<{ id: Reasoning; label: string }> = [
  { id: "low", label: "Low" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];

/** Why a model can't back this engine, or null when it can. */
export function unusableReason(m: Options["models"][number], engineApi: string | null): string | null {
  if (m.blocked) return m.blocked;
  if (engineApi && m.apis.length === 0) return "只能用于内置引擎";
  if (engineApi && !m.apis.includes(engineApi as never)) return `供应商不支持 ${API_LABEL[engineApi] ?? engineApi} 接口`;
  return null;
}

/**
 * Execution engine + model + reasoning picker (ADR-0010): engine tabs on top, the models that engine
 * can use below (others greyed with the reason), reasoning effort at the bottom. Models always come
 * from platform providers, through the platform proxy — never the harness's own login.
 */
export function EngineModelPicker(p: {
  projectId: string;
  engine: Engine;
  model: string;
  reasoning: Reasoning | null;
  allowEngines: boolean;
  onChange(v: { engine: Engine; model: string; reasoning: Reasoning | null }): void;
}) {
  const q = useQuery(modelOptionsQuery(p.projectId));
  const engines = q.data?.engines ?? [{ id: "builtin", label: "内置", api: null }];
  const current = engines.find((e) => e.id === p.engine) ?? engines[0]!;
  const models = q.data?.models ?? [];
  const external = p.engine !== "builtin";
  const set = (patch: Partial<{ engine: Engine; model: string; reasoning: Reasoning | null }>) => p.onChange({ engine: p.engine, model: p.model, reasoning: p.reasoning, ...patch });
  const pickEngine = (id: Engine) => {
    const api = engines.find((e) => e.id === id)?.api ?? null;
    const still = models.find((m) => m.name === p.model);
    // Keep the model when the new engine can use it; otherwise clear it rather than save something that can't run.
    set({ engine: id, model: still && !unusableReason(still, api) ? p.model : "" });
  };

  return (
    <div className="grid gap-3 rounded-lg border p-3" data-testid="engine-model-picker">
      {p.allowEngines && (
        <div className="grid gap-1.5">
          <div className="text-sm font-medium">执行引擎</div>
          <div role="radiogroup" aria-label="执行引擎" className="grid grid-cols-5 gap-1.5">
            {engines.map((e) => (
              <button
                key={e.id}
                type="button"
                role="radio"
                aria-checked={e.id === p.engine}
                onClick={() => pickEngine(e.id as Engine)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-xs transition-colors",
                  e.id === p.engine ? "border-primary bg-primary/5 text-foreground" : "text-muted-foreground hover:bg-muted",
                )}
              >
                <span className={cn("grid size-7 place-items-center rounded-md font-mono text-[11px] font-semibold", e.id === p.engine ? "bg-primary text-primary-foreground" : "bg-muted")}>
                  {MARK[e.id as Engine]}
                </span>
                <span className="truncate">{e.label}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {external ? `${current.label} 只负责改代码；模型走平台登记的 API（${API_LABEL[current.api ?? ""] ?? ""}），提交、推送、MR、评审仍由平台完成。` : "平台自己的 Agent 循环。"}
          </p>
        </div>
      )}

      <div className="grid gap-1.5">
        <div className="flex items-baseline justify-between text-sm font-medium">
          <span>模型</span>
          {!p.model && <span className="text-xs font-normal text-muted-foreground">未选择：用租户默认（{q.data?.defaultModel ?? "…"}）</span>}
        </div>
        <ul role="listbox" aria-label="模型" className="max-h-56 overflow-y-auto rounded-md border">
          {models.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">{q.isLoading ? "加载中…" : "还没有可用的模型：请租户管理员在「模型与预算」登记供应商"}</li>}
          {[...models]
            // Usable first, original order otherwise.
            .sort((x, y) => Number(Boolean(unusableReason(x, current.api))) - Number(Boolean(unusableReason(y, current.api))))
            .map((m) => {
              const why = unusableReason(m, current.api);
              const selected = m.name === p.model;
              return (
                <li key={`${m.provider}:${m.name}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-disabled={Boolean(why)}
                    disabled={Boolean(why)}
                    title={why ?? undefined}
                    onClick={() => set({ model: selected ? "" : m.name })}
                    className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm", why ? "cursor-not-allowed opacity-45" : "hover:bg-muted", selected && "bg-primary/5")}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[13px]">{m.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {m.provider} · {m.isExternal ? "外部" : "本地"}
                        {why ? ` · ${why}` : ""}
                      </span>
                    </span>
                    {selected && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
                  </button>
                </li>
              );
            })}
        </ul>
      </div>

      {external && (
        <div className="grid gap-1.5">
          <div className="text-sm font-medium">推理强度</div>
          <div role="radiogroup" aria-label="推理强度" className="grid grid-cols-3 gap-1.5">
            {REASONING.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={p.reasoning === r.id}
                onClick={() => set({ reasoning: p.reasoning === r.id ? null : r.id })}
                className={cn("rounded-md border py-1.5 text-sm", p.reasoning === r.id ? "border-primary bg-primary/5 font-medium" : "text-muted-foreground hover:bg-muted")}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">不选则用引擎默认。</p>
        </div>
      )}
    </div>
  );
}
