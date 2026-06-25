import { useChat } from "@ai-sdk/react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  ArrowDown,
  Loader2,
  MessageSquarePlus,
  PanelLeft,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  agentStore,
  type Conversation,
  useAgentStore,
} from "@/lib/agent-store";
import { api } from "@/lib/api";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";
import { type MessageActions, MessageParts } from "./message-parts";

type AgentConfig = { enabled: boolean; model: string };

const SUGGESTIONS = [
  "How many contacts are there, and what journeys exist?",
  "Find contacts matching doug and show one timeline",
  "Which buckets are configured?",
];

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-white/[0.03] text-accent">
        <Sparkles strokeWidth={1.5} className="h-5 w-5" />
      </div>
      <div className="space-y-1">
        <p className="font-display text-sm text-white">
          Ask the co-working agent
        </p>
        <p className="text-white/50 text-xs">
          It reads your live instance and can act — every write asks first.
        </p>
      </div>
      <div className="flex w-full flex-col gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-md border border-hairline-faint bg-white/[0.02] px-3 py-2 text-left text-sm text-white/70 transition-colors hover:bg-white/[0.05] hover:text-white"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function NotConfigured({ loading }: { loading: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-white/40" />
      ) : (
        <>
          <p className="font-display text-sm text-white">
            Agent not configured
          </p>
          <p className="text-white/50 text-xs leading-relaxed">
            Set{" "}
            <span className="font-mono text-white/70">OPENROUTER_API_KEY</span>{" "}
            (and restart the engine) to enable the co-working agent. The key
            stays server-side.
          </p>
        </>
      )}
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  onStop,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  onStop: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="border-hairline-faint border-t p-3"
    >
      <div className="flex items-end gap-2 rounded-lg border border-hairline-faint bg-white/[0.03] px-3 py-2 focus-within:border-hairline">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={1}
          placeholder="Ask the agent…"
          className="max-h-32 flex-1 resize-none bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none"
        />
        {busy ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label="Stop"
            onClick={onStop}
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            type="submit"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-accent disabled:text-white/20"
            aria-label="Send"
            disabled={!value.trim()}
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <p className="mt-1.5 px-1 text-[10px] text-white/30">
        ⏎ send · ⇧⏎ newline
      </p>
    </form>
  );
}

function EditBar({
  text,
  onSave,
  onCancel,
}: {
  text: string;
  onSave: (t: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(text);
  return (
    <div className="border-hairline-faint border-t p-3">
      <p className="mb-1.5 px-1 text-[10px] text-accent uppercase tracking-wide">
        Editing — this truncates the thread below
      </p>
      <div className="flex items-end gap-2 rounded-lg border border-hairline-faint bg-white/[0.03] px-3 py-2 focus-within:border-hairline">
        <textarea
          // biome-ignore lint/a11y/noAutofocus: focus the edit field when it opens
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSave(v);
            }
            if (e.key === "Escape") onCancel();
          }}
          rows={1}
          className="max-h-32 flex-1 resize-none bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none"
        />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={() => onSave(v)}
          disabled={!v.trim()}
        >
          Save &amp; resend
        </Button>
      </div>
    </div>
  );
}

function VirtualMessageList({
  messages,
  actions,
  streaming,
}: {
  messages: UIMessage[];
  actions: MessageActions;
  streaming: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    getItemKey: (i) => messages[i]?.id ?? i,
    overscan: 6,
  });

  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = dist < 80;
    setShowJump(!pinnedRef.current);
  }, []);

  // Autoscroll while pinned. Keyed on messages (token growth changes identity)
  // + streaming so we track the growing last row; rAF re-call catches the
  // post-measure layout pass.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages/streaming are the triggers
  useEffect(() => {
    if (!pinnedRef.current || messages.length === 0) return;
    const i = messages.length - 1;
    virtualizer.scrollToIndex(i, { align: "end" });
    const r = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(i, { align: "end" }),
    );
    return () => cancelAnimationFrame(r);
  }, [messages, streaming]);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={parentRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto px-4 py-4"
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {items.map((vi) => {
            const m = messages[vi.index];
            if (!m) return null;
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                  paddingBottom: 16,
                }}
              >
                <MessageParts message={m} actions={actions} />
              </div>
            );
          })}
        </div>
      </div>

      {showJump && streaming ? (
        <button
          type="button"
          onClick={() => {
            pinnedRef.current = true;
            setShowJump(false);
            virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
          }}
          className="-translate-x-1/2 absolute bottom-3 left-1/2 flex items-center gap-1 rounded-full border border-hairline bg-raised px-3 py-1 text-white/70 text-xs shadow-black/40 shadow-lg hover:text-white"
        >
          <ArrowDown className="h-3 w-3" /> Jump to latest
        </button>
      ) : null}
    </div>
  );
}

function ChatThread({
  conversationId,
  initialMessages,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
}) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${config.baseUrl}/v1/admin/agent/chat`,
        credentials: "include",
      }),
    [],
  );

  const {
    messages,
    sendMessage,
    setMessages,
    regenerate,
    status,
    error,
    stop,
  } = useChat({ id: conversationId, messages: initialMessages, transport });

  const [input, setInput] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  );
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    agentStore.saveMessages(conversationId, messages);
  }, [conversationId, messages]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    void sendMessage({ text: t });
  };

  // EDIT: truncate from the user msg, resend the edited text.
  const saveEdit = (id: string, newText: string) => {
    const t = newText.trim();
    if (!t) return;
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    setMessages((prev) => prev.slice(0, idx));
    setEditing(null);
    void sendMessage({ text: t });
  };

  // REGENERATE: v6 truncates to the messageId + re-streams it.
  const onRegenerate = (id: string) => {
    if (busy) return;
    void regenerate({ messageId: id });
  };

  // ROLLBACK: keep through this msg, drop the tail, persist.
  const onRollback = (id: string) => {
    if (busy) return;
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    setMessages((prev) => prev.slice(0, idx + 1));
    agentStore.truncate(conversationId, idx + 1);
  };

  const actions: MessageActions = {
    busy,
    onEdit: (id, text) => setEditing({ id, text }),
    onRegenerate,
    onRollback,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col overflow-y-auto px-4 py-4">
          <EmptyState onPick={send} />
        </div>
      ) : (
        <VirtualMessageList
          messages={messages}
          actions={actions}
          streaming={busy}
        />
      )}

      {error ? (
        <div className="mx-4 mb-2 rounded-md border border-accent/40 bg-accent-tint px-3 py-2 text-sm text-white/80">
          {error.message || "Something went wrong talking to the agent."}
        </div>
      ) : null}

      {editing ? (
        <EditBar
          text={editing.text}
          onCancel={() => setEditing(null)}
          onSave={(t) => saveEdit(editing.id, t)}
        />
      ) : (
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => send(input)}
          busy={busy}
          onStop={stop}
        />
      )}
    </div>
  );
}

function ConversationRail({
  conversations,
  activeId,
  onClose,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-y-0 left-0 z-10 flex w-56 flex-col border-hairline-faint border-r bg-raised">
      <div className="flex items-center justify-between border-hairline-faint border-b px-3 py-2">
        <span className="text-white/50 text-xs uppercase tracking-wide">
          Chats
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="New chat"
          onClick={() => {
            agentStore.create();
            onClose();
          }}
        >
          <MessageSquarePlus className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-3 text-white/40 text-xs">
            No conversations yet.
          </p>
        ) : (
          conversations.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center gap-1 rounded-md px-2 py-1.5",
                c.id === activeId
                  ? "bg-accent-tint text-accent"
                  : "text-white/60 hover:bg-white/5 hover:text-white",
              )}
            >
              <button
                type="button"
                className="flex-1 truncate text-left text-sm"
                onClick={() => {
                  agentStore.setActive(c.id);
                  onClose();
                }}
              >
                {c.title}
              </button>
              <button
                type="button"
                aria-label="Delete chat"
                className="shrink-0 text-white/30 opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
                onClick={() => agentStore.remove(c.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function AgentPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const store = useAgentStore();
  const [railOpen, setRailOpen] = useState(false);

  const configQuery = useQuery({
    queryKey: ["agent", "config"],
    queryFn: () => api.get<AgentConfig>("/v1/admin/agent/config"),
    enabled: open,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (open) agentStore.ensureActive();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const activeId = store.activeId;
  const active = store.conversations.find((c) => c.id === activeId);
  const enabled = configQuery.data?.enabled ?? false;
  const model = configQuery.data?.model ?? "";

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close agent"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="absolute inset-y-0 right-0 flex w-full max-w-[440px] flex-col border-white/10 border-l bg-raised text-white shadow-black/50 shadow-xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-1 border-hairline-faint border-b px-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Conversations"
            onClick={() => setRailOpen((v) => !v)}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
          <span className="flex-1 truncate px-1 font-display text-sm text-white tracking-[-0.02em]">
            {active?.title ?? "Agent"}
          </span>
          {model ? (
            <span className="hidden shrink-0 px-1 font-mono text-[10px] text-white/40 sm:inline">
              {model}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="New chat"
            onClick={() => {
              agentStore.create();
              setRailOpen(false);
            }}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          {!enabled ? (
            <NotConfigured loading={configQuery.isLoading} />
          ) : activeId ? (
            <ChatThread
              key={activeId}
              conversationId={activeId}
              initialMessages={active?.messages ?? []}
            />
          ) : null}

          {railOpen ? (
            <ConversationRail
              conversations={store.conversations}
              activeId={activeId}
              onClose={() => setRailOpen(false)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
