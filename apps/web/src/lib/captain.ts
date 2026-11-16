import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, unwrap } from "./api";
import { queryClient } from "./query";
import { realtime } from "./realtime";

export const ck = {
  summary: (groupId: string) => ["summary", groupId] as const,
  decisions: (groupId: string) => ["decisions", groupId] as const,
  questions: (groupId: string) => ["questions", groupId] as const,
  sessions: (projectId: string) => ["sessions", projectId] as const,
  session: (id: string) => ["session", id] as const,
  models: ["admin-models"] as const,
  usage: ["admin-usage"] as const,
  paused: ["agents-paused"] as const,
};

export const summaryQuery = (groupId: string) => ({ queryKey: ck.summary(groupId), queryFn: () => unwrap(api.api.v1.groups({ id: groupId }).summary.get()) });
export const useSummary = (groupId: string) => useQuery(summaryQuery(groupId));
export const decisionsQuery = (groupId: string) => ({ queryKey: ck.decisions(groupId), queryFn: () => unwrap(api.api.v1.groups({ id: groupId }).decisions.get()) });
export const useDecisions = (groupId: string) => useQuery(decisionsQuery(groupId));
export const useQuestions = (groupId: string) => useQuery({ queryKey: ck.questions(groupId), queryFn: () => unwrap(api.api.v1.groups({ id: groupId }).questions.get()) });
export const useSessions = (projectId: string) => useQuery({ queryKey: ck.sessions(projectId), queryFn: () => unwrap(api.api.v1.projects({ id: projectId }).sessions.get()) });
export const useSessionDetail = (id: string | null) => useQuery({ queryKey: ck.session(id ?? ""), queryFn: () => unwrap(api.api.v1.sessions({ id: id! }).get()), enabled: Boolean(id) });
export const useModels = (enabled = true) => useQuery({ queryKey: ck.models, queryFn: () => unwrap(api.api.v1.admin.models.get()), enabled, retry: false });

export type Summary = NonNullable<Awaited<ReturnType<ReturnType<typeof summaryQuery>["queryFn"]>>["summary"]>;
export type SummaryContent = Summary["content"];
export type Decision = Awaited<ReturnType<ReturnType<typeof decisionsQuery>["queryFn"]>>[number];

export const SUMMARY_SECTIONS: Array<{ key: keyof SummaryContent; label: string; dot: string; empty: string }> = [
  { key: "decisions", label: "决策", dot: "bg-ok", empty: "还没有达成一致的决定" },
  { key: "openQuestions", label: "未决问题", dot: "bg-attention", empty: "暂时没有待回答的问题" },
  { key: "constraints", label: "约束", dot: "bg-info", empty: "没有记录到约束" },
  { key: "taskGraph", label: "任务脉络", dot: "bg-primary", empty: "还没有提到具体工作" },
  { key: "risks", label: "风险与线索", dot: "bg-danger", empty: "没有记录到风险" },
];

export async function decide(id: string, action: "confirm" | "reject" | "revoke", reason?: string) {
  return unwrap(api.api.v1.decisions({ id })({ action }).post({ reason }));
}
export async function answerQuestion(id: string, body: { option?: string; text?: string }) {
  return unwrap(api.api.v1.questions({ id }).answer.post(body));
}

/** Invalidates captain caches from a group/project event frame. */
export function invalidateCaptain(type: string, payload: Record<string, unknown>) {
  const g = typeof payload.groupId === "string" ? payload.groupId : null;
  if (!g) return;
  if (type === "summary.updated") void queryClient.invalidateQueries({ queryKey: ck.summary(g) });
  if (type.startsWith("decision.") || type === "summary.updated") void queryClient.invalidateQueries({ queryKey: ck.decisions(g) });
  if (type.startsWith("question.")) void queryClient.invalidateQueries({ queryKey: ck.questions(g) });
}

/**
 * Streaming captain replies (LLM-12): deltas arrive as `stream` frames on the group topic and
 * are shown as a live bubble until the real message (same id) lands in the timeline.
 */
export function useStreams(groupId: string) {
  const [streams, setStreams] = useState<Record<string, string>>({});
  useEffect(() => {
    const topic = `group:${groupId}`;
    const off = realtime.onFrame((f) => {
      if (f.topic !== topic || f.type !== "stream") return;
      setStreams((s) => {
        if (f.done) {
          const { [f.messageId]: _gone, ...rest } = s;
          return rest;
        }
        return { ...s, [f.messageId]: (s[f.messageId] ?? "") + f.delta };
      });
    });
    return () => {
      off();
      setStreams({});
    };
  }, [groupId]);
  return streams;
}
