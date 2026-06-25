import type { UIMessage } from "ai";
import { useSyncExternalStore } from "react";

/**
 * Multi-chat persistence for the Studio co-working agent, kept entirely in
 * localStorage (v1 — the server is stateless; every committed effect is durable
 * via audit_logs/email_sends anyway). A tiny useSyncExternalStore-backed store,
 * matching the client-side-layer build philosophy (zero deps, no external state
 * lib). Conversations hold the raw UIMessage[] so tool-call + streaming parts
 * replay correctly on reload.
 */
export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  messages: UIMessage[];
};

type State = { conversations: Conversation[]; activeId: string | null };

const STORE_KEY = "hogsend.agent.v1";
const MAX_CONVERSATIONS = 50;

function uid(): string {
  return `c_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function load(): State {
  if (typeof window === "undefined")
    return { conversations: [], activeId: null };
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return { conversations: [], activeId: null };
    const parsed = JSON.parse(raw) as State;
    if (!Array.isArray(parsed.conversations)) {
      return { conversations: [], activeId: null };
    }
    return parsed;
  } catch {
    return { conversations: [], activeId: null };
  }
}

let state: State = load();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function commit(next: State) {
  state = next;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Quota or serialization failure — keep the in-memory state, drop persistence.
  }
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): State {
  return state;
}

export function useAgentStore(): State {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function deriveTitle(messages: UIMessage[]): string | null {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return null;
  const text = firstUser.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
  if (!text) return null;
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

export const agentStore = {
  /** Create a fresh conversation and make it active. Returns its id. */
  create(): string {
    const conv: Conversation = {
      id: uid(),
      title: "New chat",
      createdAt: Date.now(),
      messages: [],
    };
    const conversations = [conv, ...state.conversations].slice(
      0,
      MAX_CONVERSATIONS,
    );
    commit({ conversations, activeId: conv.id });
    return conv.id;
  },

  /** Ensure there is an active conversation; create one if the store is empty. */
  ensureActive(): string {
    if (
      state.activeId &&
      state.conversations.some((c) => c.id === state.activeId)
    ) {
      return state.activeId;
    }
    if (state.conversations[0]) {
      commit({ ...state, activeId: state.conversations[0].id });
      return state.conversations[0].id;
    }
    return agentStore.create();
  },

  setActive(id: string) {
    if (id === state.activeId) return;
    commit({ ...state, activeId: id });
  },

  rename(id: string, title: string) {
    commit({
      ...state,
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title: title.trim() || c.title } : c,
      ),
    });
  },

  remove(id: string) {
    const conversations = state.conversations.filter((c) => c.id !== id);
    const activeId =
      state.activeId === id ? (conversations[0]?.id ?? null) : state.activeId;
    commit({ conversations, activeId });
  },

  /** Persist the live messages for a conversation (called as the chat streams). */
  saveMessages(id: string, messages: UIMessage[]) {
    let changed = false;
    const conversations = state.conversations.map((c) => {
      if (c.id !== id) return c;
      changed = true;
      const autoTitle =
        c.title === "New chat" ? (deriveTitle(messages) ?? c.title) : c.title;
      return { ...c, messages, title: autoTitle };
    });
    if (!changed) return;
    commit({ ...state, conversations });
  },

  get(id: string | null): Conversation | undefined {
    if (!id) return undefined;
    return state.conversations.find((c) => c.id === id);
  },
};
