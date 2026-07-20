import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type Contact, contactKey, listContacts } from "@/lib/admin-api";
import { cn } from "@/lib/utils";

/**
 * A contact selector with SERVER-side search — contacts aren't a bounded
 * catalog, so each (debounced) query hits `/v1/admin/contacts?search=`
 * (substring over email / externalId / anonymousId / discordId) instead of
 * downloading the book. `emit` decides what a pick produces:
 *
 * - `"key"` — the ingest-facing contact key (`externalId ?? anonymousId ??
 *   id`), the EXACT value the admin event/send `userId` filters match.
 * - `"email"` — the contact's email (rows without one are hidden).
 *
 * `allowCustom` keeps the field open-vocabulary (a raw test id, an email not
 * yet in the book); `allowClear` is the filter "All" state. `onPick` hands
 * the full contact to the caller for side-fills (e.g. auto-filling email).
 */
export function ContactPicker({
  ariaLabel,
  value,
  placeholder,
  onChange,
  onPick,
  className,
  emit = "key",
  allowClear = false,
  allowCustom = false,
}: {
  ariaLabel: string;
  value: string;
  placeholder: string;
  onChange: (next: string) => void;
  onPick?: (contact: Contact) => void;
  className?: string;
  emit?: "key" | "email";
  allowClear?: boolean;
  allowCustom?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounce the typed query into the committed server search term.
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const contactsQuery = useQuery({
    queryKey: ["contact-picker", search],
    queryFn: () => listContacts({ search: search || undefined, limit: 20 }),
    enabled: open,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const emitted = (c: Contact) =>
    emit === "email" ? (c.email ?? "") : contactKey(c);
  const contacts = (contactsQuery.data?.contacts ?? []).filter(
    (c) => emitted(c) !== "",
  );
  const trimmed = query.trim();
  const custom =
    allowCustom &&
    trimmed !== "" &&
    !contacts.some((c) => emitted(c) === trimmed);
  // rows: an optional "use raw value" row, then the server page.
  const rowCount = contacts.length + (custom ? 1 : 0);
  const rowContact = (i: number): Contact | null =>
    custom ? (i === 0 ? null : contacts[i - 1]!) : contacts[i]!;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pickRow(i: number) {
    const contact = rowContact(i);
    onChange(contact ? emitted(contact) : trimmed);
    if (contact) onPick?.(contact);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rowCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rowCount > 0) pickRow(Math.min(active, rowCount - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
      inputRef.current?.blur();
    }
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        placeholder={placeholder}
        value={open ? query : value}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="flex h-9 w-full rounded-md border border-hairline-faint bg-white/[0.04] py-1 pl-3 pr-8 text-sm text-white transition-colors duration-200 placeholder:text-white/40 hover:border-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      {allowClear && value !== "" ? (
        <button
          type="button"
          aria-label={`Clear ${ariaLabel}`}
          // mousedown, not click: it must win against the input's blur/close.
          onMouseDown={(e) => {
            e.preventDefault();
            onChange("");
            setOpen(false);
            setQuery("");
          }}
          className="absolute right-7 top-1/2 -translate-y-1/2 text-white/40 transition-colors hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />

      {open ? (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-30 mt-1 max-h-80 w-full min-w-72 overflow-y-auto rounded-md border border-white/[0.1] bg-[#141010] py-1 shadow-xl"
        >
          <p className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2 text-xs text-white/35">
            <Search className="h-3 w-3" />
            {contactsQuery.isFetching
              ? "Searching contacts…"
              : "Search by email, external id, or anonymous id"}
          </p>
          {custom ? (
            <button
              type="button"
              role="option"
              aria-selected={false}
              data-index={0}
              onMouseDown={(e) => {
                e.preventDefault();
                pickRow(0);
              }}
              onMouseEnter={() => setActive(0)}
              className={cn(
                "w-full px-3 py-1.5 text-left text-sm italic text-white/60",
                active === 0 ? "bg-white/[0.06] text-white" : "",
              )}
            >
              Use "{trimmed}"
            </button>
          ) : null}
          {contacts.length === 0 && !custom ? (
            <p className="px-3 py-2 text-sm text-white/40">
              {contactsQuery.isPending ? "Loading…" : "No contacts match"}
            </p>
          ) : (
            contacts.map((c, ci) => {
              const i = ci + (custom ? 1 : 0);
              const key = contactKey(c);
              return (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={emitted(c) === value}
                  data-index={i}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickRow(i);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left",
                    i === active ? "bg-white/[0.06]" : "",
                  )}
                >
                  <span
                    className={cn(
                      "truncate text-sm",
                      emitted(c) === value ? "text-accent" : "text-white/85",
                    )}
                  >
                    {c.email ?? key}
                  </span>
                  {c.email ? (
                    <span className="truncate font-mono text-[11px] text-white/35">
                      {key}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
