import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ExternalLink, Search } from "lucide-react";
import { useEffect, useState } from "react";
import {
  PICKER_INPUT_CLASS,
  PickerClearButton,
  usePicker,
} from "@/components/ui/picker";
import {
  type Contact,
  contactKey,
  getContact,
  listContacts,
} from "@/lib/admin-api";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A contact selector with SERVER-side search — contacts aren't a bounded
 * catalog, so each (debounced) query hits `/v1/admin/contacts?search=`
 * (substring over email / externalId / anonymousId / discordId) instead of
 * downloading the book. Two panes, like the event picker: results left, a
 * profile card for the highlighted person right (identity keys, first/last
 * seen, groups, properties, and an open-profile deep link). `emit` decides
 * what a pick produces:
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
  const picker = usePicker();
  const [search, setSearch] = useState("");

  // Debounce the typed query into the committed server search term.
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(picker.query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [picker.query]);

  const contactsQuery = useQuery({
    queryKey: ["contact-picker", search],
    queryFn: () => listContacts({ search: search || undefined, limit: 20 }),
    enabled: picker.open,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const emitted = (c: Contact) =>
    emit === "email" ? (c.email ?? "") : contactKey(c);
  const contacts = (contactsQuery.data?.contacts ?? []).filter(
    (c) => emitted(c) !== "",
  );
  const trimmed = picker.query.trim();
  const custom =
    allowCustom &&
    trimmed !== "" &&
    !contacts.some((c) => emitted(c) === trimmed);
  // rows: an optional "use raw value" row, then the server page.
  const rowCount = contacts.length + (custom ? 1 : 0);
  const rowContact = (i: number): Contact | undefined =>
    custom ? (i === 0 ? undefined : contacts[i - 1]) : contacts[i];

  // The profile card follows the highlighted row; the custom row (index 0
  // when present) has no contact and shows the open-vocabulary explainer.
  const detailContact = rowContact(picker.active) ?? rowContact(custom ? 1 : 0);
  const showCustomDetail = custom && picker.active === 0;

  function pickRow(i: number) {
    const contact = rowContact(i);
    onChange(contact ? emitted(contact) : trimmed);
    if (contact) onPick?.(contact);
    picker.close();
  }

  return (
    <div ref={picker.rootRef} className={cn("relative", className)}>
      <input
        ref={picker.inputRef}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={picker.open ? picker.query : value}
        onKeyDown={picker.keyDown(rowCount, pickRow)}
        className={PICKER_INPUT_CLASS}
        {...picker.inputProps}
      />
      {allowClear && value !== "" ? (
        <PickerClearButton
          label={`Clear ${ariaLabel}`}
          onClear={() => {
            onChange("");
            picker.close();
          }}
        />
      ) : null}
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />

      {picker.open ? (
        <div className="absolute z-30 mt-1 w-[40rem] max-w-[calc(100vw-3rem)] overflow-hidden rounded-md border border-white/[0.1] bg-[#141010] shadow-xl">
          <p className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2 text-xs text-white/35">
            <Search className="h-3 w-3" />
            {contactsQuery.isFetching
              ? "Searching contacts…"
              : "Search by email, external id, or anonymous id"}
          </p>
          <div className="flex">
            <div
              ref={picker.listRef}
              role="listbox"
              className="max-h-80 w-1/2 overflow-y-auto py-1"
            >
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
                  onMouseEnter={() => picker.setActive(0)}
                  className={cn(
                    "w-full px-3 py-1.5 text-left text-sm italic text-white/60",
                    picker.active === 0 ? "bg-white/[0.06] text-white" : "",
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
                      onMouseEnter={() => picker.setActive(i)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left",
                        i === picker.active ? "bg-white/[0.06]" : "",
                      )}
                    >
                      <span
                        className={cn(
                          "truncate text-sm",
                          emitted(c) === value
                            ? "text-accent"
                            : "text-white/85",
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

            <div className="max-h-80 w-1/2 overflow-y-auto border-l border-white/[0.06] p-4">
              {showCustomDetail ? (
                <div className="space-y-3">
                  <p className="break-all font-mono text-sm text-white">
                    {trimmed}
                  </p>
                  <p className="text-xs text-white/40">
                    Not in the contact book yet — the raw value is used as-is.
                  </p>
                </div>
              ) : detailContact ? (
                <ContactDetailPane contact={detailContact} />
              ) : (
                <p className="text-sm text-white/40">
                  No contact highlighted yet.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="eyebrow text-[10px] text-white/35">{label}</p>
      <p className="mt-0.5 break-all font-mono text-xs text-white/80">
        {value}
      </p>
    </div>
  );
}

/** One property as a compact key/value line; non-scalars render as JSON. */
function propValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * The profile card for the highlighted contact. The list row already carries
 * identity + timestamps + properties; groups come from one detail fetch,
 * cached per contact and only issued while the popover is open.
 */
function ContactDetailPane({ contact }: { contact: Contact }) {
  const detailQuery = useQuery({
    queryKey: ["contact-picker-detail", contact.id],
    queryFn: () => getContact(contact.id),
    staleTime: 60_000,
  });
  const memberships = detailQuery.data?.groups ?? [];
  const properties = Object.entries(contact.properties ?? {});

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="break-all text-sm text-white">
          {contact.email ?? contactKey(contact)}
        </p>
        <Link
          to="/contacts"
          search={{ contact: contact.id }}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-white/45 transition-colors hover:text-white"
        >
          Open profile
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-3">
        <DetailRow
          label="First seen"
          value={
            contact.firstSeenAt ? formatRelative(contact.firstSeenAt) : "—"
          }
        />
        <DetailRow
          label="Last seen"
          value={contact.lastSeenAt ? formatRelative(contact.lastSeenAt) : "—"}
        />
        {contact.externalId ? (
          <DetailRow label="External ID" value={contact.externalId} />
        ) : null}
        {contact.anonymousId ? (
          <DetailRow label="Anonymous ID" value={contact.anonymousId} />
        ) : null}
      </div>

      {memberships.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-white/[0.06] pt-3">
          {memberships.slice(0, 4).map((m) => (
            <Link
              key={`${m.groupType}:${m.groupKey}`}
              to="/groups/$groupType/$groupKey"
              params={{ groupType: m.groupType, groupKey: m.groupKey }}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-full border border-white/[0.12] bg-white/[0.03] px-2 py-0.5 text-[11px] text-white/75 transition-colors hover:border-white/[0.3] hover:text-white"
            >
              {m.displayName ?? m.groupKey}
            </Link>
          ))}
          {memberships.length > 4 ? (
            <span className="text-[11px] text-white/40">
              +{memberships.length - 4} more
            </span>
          ) : null}
        </div>
      ) : null}

      {properties.length > 0 ? (
        <div className="space-y-1.5 border-t border-white/[0.06] pt-3">
          <p className="eyebrow text-[10px] text-white/35">Properties</p>
          {properties.map(([key, value]) => (
            <p
              key={key}
              className="truncate font-mono text-[11px] text-white/60"
            >
              <span className="text-white/40">{key}:</span> {propValue(value)}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
