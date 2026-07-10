/**
 * The "Append arrival ref" opt-in, shared by the Links create/edit dialogs and
 * the New QR code dialog. When on, redirects append `hs_ref=<click id>` so the
 * landing page can report the visitor back (`POST /v1/t/arrive`) — the
 * known-contact arrival story.
 */
export function AppendRefField({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={id}
        className="flex items-center gap-2 text-sm text-white/80"
      >
        <input
          id={id}
          type="checkbox"
          className="h-4 w-4 rounded border-hairline-faint accent-accent"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        Append arrival ref
      </label>
      <p className="text-white/40 text-xs">
        Adds a per-hit <code>hs_ref</code> param to the destination so your
        landing page can report who arrived — including known contacts. Leave
        off for destinations that reject extra params (e.g. OAuth redirect
        URIs).
      </p>
    </div>
  );
}
