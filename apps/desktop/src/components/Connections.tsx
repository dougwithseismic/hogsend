import { useEffect, useState } from "react";
import {
  clearCredentials,
  credentialsEmail,
  saveCredentials,
} from "@/lib/bridge";
import {
  connectionLabel,
  createConnection,
  DEFAULT_BASE_URL,
} from "@/lib/connections";
import type { Connection } from "@/lib/types";

export function ConnectionPicker({
  connections,
  activeId,
  onSelect,
  onAdd,
  onRemove,
}: {
  connections: Connection[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: (conn: Connection) => void;
  onRemove: (id: string) => void;
}) {
  const [adding, setAdding] = useState(connections.length === 0);
  const [url, setUrl] = useState(DEFAULT_BASE_URL);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      setError("Enter a full URL, e.g. https://t.hogsend.com");
      return;
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      setError("URL must be http or https");
      return;
    }
    onAdd(createConnection(url));
    setUrl(DEFAULT_BASE_URL);
    setError(null);
    setAdding(false);
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        {connections.map((c) => (
          <div
            key={c.id}
            className={`group flex items-center justify-between rounded-lg px-2.5 py-2 ${
              c.id === activeId
                ? "bg-neutral-800 ring-1 ring-neutral-700"
                : "hover:bg-neutral-800/50"
            }`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => onSelect(c.id)}
            >
              <div className="truncate text-sm text-neutral-200">
                {connectionLabel(c.baseUrl)}
              </div>
            </button>
            <button
              type="button"
              aria-label={`Remove ${connectionLabel(c.baseUrl)}`}
              className="ml-2 hidden text-neutral-600 hover:text-red-400 group-hover:block"
              onClick={() => onRemove(c.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {adding ? (
        <form
          onSubmit={submit}
          className="space-y-2 rounded-lg bg-neutral-800/60 p-2.5"
        >
          <input
            className="w-full rounded-md bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:ring-1 focus:ring-neutral-600"
            placeholder="https://t.hogsend.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {error && <div className="text-[11px] text-red-400">{error}</div>}
          <div className="flex gap-2">
            <button
              type="submit"
              className="flex-1 rounded-md bg-neutral-200 px-2.5 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
            >
              Connect
            </button>
            {connections.length > 0 && (
              <button
                type="button"
                className="rounded-md px-2.5 py-1.5 text-sm text-neutral-400 hover:text-neutral-200"
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="w-full rounded-lg border border-dashed border-neutral-700 px-2.5 py-2 text-sm text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
          onClick={() => setAdding(true)}
        >
          + Add instance
        </button>
      )}
    </div>
  );
}

/**
 * Per-instance auto-login. Credentials are stored in the OS keychain via the
 * Rust side; the Studio window uses them to sign itself in. The password is
 * write-only from the UI's perspective — we only ever read back the email.
 */
export function AutoLogin({ baseUrl }: { baseUrl: string }) {
  const [savedEmail, setSavedEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSavedEmail(null);
    setOpen(false);
    credentialsEmail(baseUrl)
      .then(setSavedEmail)
      .catch(() => setSavedEmail(null));
  }, [baseUrl]);

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError("Email and password are required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveCredentials(baseUrl, email.trim(), password);
      setSavedEmail(email.trim());
      setEmail("");
      setPassword("");
      setOpen(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    await clearCredentials(baseUrl).catch(() => {});
    setSavedEmail(null);
  }

  if (savedEmail) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-neutral-800 px-3 py-2 text-xs">
        <span className="truncate text-neutral-400">
          <span className="text-emerald-400">●</span> Auto-login · {savedEmail}
        </span>
        <button
          type="button"
          className="ml-2 text-neutral-500 hover:text-red-400"
          onClick={remove}
        >
          Remove
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="w-full rounded-lg border border-dashed border-neutral-800 px-3 py-2 text-xs text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
        onClick={() => setOpen(true)}
      >
        Enable auto-login
      </button>
    );
  }

  return (
    <form
      onSubmit={enable}
      className="space-y-2 rounded-lg border border-neutral-800 p-2.5"
    >
      <div className="text-[11px] text-neutral-500">
        Signs Studio in automatically. Stored in your macOS Keychain.
      </div>
      <input
        type="email"
        autoComplete="off"
        className="w-full rounded-md bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:ring-1 focus:ring-neutral-600"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        type="password"
        autoComplete="off"
        className="w-full rounded-md bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:ring-1 focus:ring-neutral-600"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <div className="text-[11px] text-red-400">{error}</div>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="flex-1 rounded-md bg-neutral-200 px-2.5 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="rounded-md px-2.5 py-1.5 text-sm text-neutral-400 hover:text-neutral-200"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
