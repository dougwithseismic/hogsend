import { createContext, useContext } from "react";

/**
 * Lets any view under <AppShell> open the co-working agent panel (mirrors
 * FireEventContext). AppShell owns the open state and provides the opener.
 */
const AgentChatContext = createContext<(() => void) | null>(null);

export { AgentChatContext };

export function useOpenAgent(): () => void {
  const open = useContext(AgentChatContext);
  if (!open) {
    throw new Error("useOpenAgent must be used within <AppShell>");
  }
  return open;
}
