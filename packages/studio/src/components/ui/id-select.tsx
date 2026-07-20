import { Select } from "@/components/ui/select";

/** A native select that always includes the current value as an option, so a
 * stored id/name that isn't in the (bounded) catalog still round-trips. */
export function IdSelect({
  ariaLabel,
  value,
  options,
  placeholder,
  onChange,
  className,
}: {
  ariaLabel: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  placeholder: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const known = options.some((o) => o.value === value);
  return (
    <Select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    >
      {value === "" ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {!known && value !== "" ? <option value={value}>{value}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}
