import { useChat } from "@ai-sdk/react";
import { useQuery } from "@tanstack/react-query";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  Loader2,
  MessageSquarePlus,
  PanelLeft,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  agentStore,
  type Conversation,
  useAgentStore,
} from "@/lib/agent-store";
import { api } from "@/lib/api";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";
import { MessageParts } from "./message-parts";

type AgentConfig = { enabled: boolean; model: string };

const SUGGESTIONS = [
  "How many contacts are there, and what journeys exist?",
  "Show me the 10 most recent events",
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
          It reads your live instance — contacts, events, journeys, buckets.
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

  const { messages, sendMessage, status, error, stop } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
  });

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    agentStore.saveMessages(conversationId, messages);
  }, [conversationId, messages]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is the scroll trigger, not read in the body
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    void sendMessage({ text: t });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 ? (
          <EmptyState onPick={send} />
        ) : (
          messages.map((m) => <MessageParts key={m.id} message={m} />)
        )}
        {error ? (
          <div className="rounded-md border border-accent/40 bg-accent-tint px-3 py-2 text-sm text-white/80">
            {error.message || "Something went wrong talking to the agent."}
          </div>
        ) : null}
      </div>
      <Composer
        value={input}
        onChange={setInput}
        onSubmit={() => send(input)}
        busy={busy}
        onStop={stop}
      />
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
          <span className="flex-1 truncate px-1 font-display text-sm tracking-[-0.02em] text-white">
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
