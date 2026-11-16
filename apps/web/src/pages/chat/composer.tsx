import { CornerUpLeft, Loader2, Paperclip, SendHorizonal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { PrincipalAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Msg } from "./timeline-store";

export interface MemberLite {
  principalId: string;
  name: string;
  kind: string;
  agentRole: string | null;
  active: boolean;
}

/** Slash commands (§13.3). Execution arrives with the stages that own them; here they insert templates. */
export const COMMANDS = [
  { cmd: "/task", hint: "让船长根据讨论提议一个任务", template: "/task " },
  { cmd: "/summary", hint: "请船长更新本群摘要", template: "/summary" },
  { cmd: "/ask", hint: "向项目船长提问", template: "/ask " },
  { cmd: "/assign", hint: "把任务分配给某人：/assign PAY-12 @名字", template: "/assign " },
];

type Upload = { id: string; name: string; size: number };

export function Composer({
  groupId,
  members,
  disabledReason,
  replyTo,
  onCancelReply,
  onSend,
}: {
  groupId: string;
  members: MemberLite[];
  disabledReason?: string | null;
  replyTo: Msg | null;
  onCancelReply(): void;
  onSend(body: string, attachmentIds: string[], replyToId?: string): void;
}) {
  const draftKey = `ap.draft.${groupId}`;
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [menu, setMenu] = useState<{ kind: "mention" | "command"; query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const h = setTimeout(() => (text ? localStorage.setItem(draftKey, text) : localStorage.removeItem(draftKey)), 300);
    return () => clearTimeout(h);
  }, [text, draftKey]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  useEffect(() => {
    if (replyTo) ref.current?.focus();
  }, [replyTo]);
  // Clicking a member in the right panel inserts an @mention at the caret.
  useEffect(() => {
    const h = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      const token = /\s/.test(name) ? `@"${name}" ` : `@${name} `;
      const el = ref.current;
      const at = el?.selectionStart ?? text.length;
      setText((t) => t.slice(0, at) + (at > 0 && !/\s$/.test(t.slice(0, at)) ? " " : "") + token + t.slice(at));
      requestAnimationFrame(() => el?.focus());
    };
    window.addEventListener("ap:insert-mention", h);
    return () => window.removeEventListener("ap:insert-mention", h);
  }, [text.length]);

  const options = useMemo(() => {
    if (!menu) return [];
    const q = menu.query.toLowerCase();
    if (menu.kind === "command")
      return COMMANDS.filter((c) => c.cmd.slice(1).startsWith(q)).map((c) => ({ key: c.cmd, label: c.cmd, hint: c.hint, insert: c.template, member: null as MemberLite | null }));
    return members
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((m) => ({
        key: m.principalId,
        label: m.name,
        hint: m.kind === "agent" ? (m.active ? "Agent" : "Agent · 已停用") : "",
        insert: /\s/.test(m.name) ? `@"${m.name}" ` : `@${m.name} `,
        member: m,
      }));
  }, [menu, members]);

  function detect(value: string, caret: number) {
    const before = value.slice(0, caret);
    const at = before.match(/(^|\s)@([^\s@"]*)$/u);
    if (at) return setMenu({ kind: "mention", query: at[2] ?? "", start: caret - (at[2]?.length ?? 0) - 1 });
    const slash = before.match(/^\/(\w*)$/);
    if (slash) return setMenu({ kind: "command", query: slash[1] ?? "", start: 0 });
    setMenu(null);
  }

  function pick(i: number) {
    const o = options[i];
    const el = ref.current;
    if (!o || !el || !menu) return;
    const caret = el.selectionStart;
    const next = text.slice(0, menu.start) + o.insert + text.slice(caret);
    setText(next);
    setMenu(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = menu.start + o.insert.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const j = await unwrap(api.api.v1.groups({ id: groupId }).attachments.post({ file }));
      setUploads((u) => [...u, { id: j.id, name: j.name, size: j.size }]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }

  function submit() {
    const body = text.trim();
    if ((!body && uploads.length === 0) || disabledReason) return;
    if (body.length > 20_000) {
      toast.error("消息超过 2 万字，请改为附件上传");
      return;
    }
    onSend(
      body,
      uploads.map((u) => u.id),
      replyTo?.id,
    );
    setText("");
    setUploads([]);
    localStorage.removeItem(draftKey);
    onCancelReply();
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (menu && options.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % options.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(active);
        return;
      }
      if (e.key === "Escape") {
        setMenu(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape" && replyTo) onCancelReply();
  }

  return (
    <div className="border-t bg-background px-4 pt-2 pb-3">
      {replyTo && (
        <div className="mb-1.5 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          <CornerUpLeft className="size-3.5" /> 回复 <span className="font-medium text-foreground">{replyTo.author.name}</span>
          <span className="truncate">{replyTo.body.slice(0, 80)}</span>
          <button type="button" className="ml-auto" onClick={onCancelReply} aria-label="取消回复">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div className={cn("relative rounded-lg border bg-card focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/15", disabledReason && "opacity-60")}>
        {menu && options.length > 0 && (
          <div className="absolute bottom-full left-2 z-30 mb-1 w-80 overflow-hidden rounded-md border bg-popover shadow-md" role="listbox" aria-label={menu.kind === "mention" ? "提及成员" : "命令"}>
            {options.map((o, i) => (
              <button
                key={o.key}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(i);
                }}
                className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm", i === active && "bg-accent")}
              >
                {o.member ? <PrincipalAvatar name={o.member.name} kind={o.member.kind} size="sm" /> : <span className="font-mono text-xs text-primary">{o.label}</span>}
                {o.member && <span className={cn(!o.member.active && "text-muted-foreground line-through")}>{o.label}</span>}
                <span className="ml-auto truncate text-xs text-muted-foreground">{o.hint}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          disabled={Boolean(disabledReason)}
          placeholder={disabledReason ?? "发消息…  @ 提及成员或 Agent，/ 使用命令，Enter 发送，Shift+Enter 换行"}
          aria-label="消息输入框"
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            detect(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKey}
          onPaste={(e) => {
            const f = [...e.clipboardData.files].find((x) => x.type.startsWith("image/"));
            if (f) {
              e.preventDefault();
              void upload(f);
            }
          }}
          className="block max-h-60 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-muted-foreground"
        />
        {uploads.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pb-1">
            {uploads.map((u) => (
              <span key={u.id} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs">
                <Paperclip className="size-3" /> {u.name}
                <button type="button" aria-label={`移除 ${u.name}`} onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between px-2 pb-1.5">
          <label className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />} 附件
            <input
              type="file"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = "";
              }}
            />
          </label>
          <div className="flex items-center gap-2">
            <span className={cn("text-[11px] tabular-nums text-muted-foreground", text.length > 18_000 && "text-danger")}>{text.length > 1000 ? `${text.length} / 20000` : ""}</span>
            <Button size="sm" className="h-7" onClick={submit} disabled={Boolean(disabledReason) || (!text.trim() && uploads.length === 0)} aria-label="发送">
              <SendHorizonal className="size-3.5" /> 发送
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
