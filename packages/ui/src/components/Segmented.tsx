"use client";
export interface SegOption<T extends string> { value: T; label: string }
export function Segmented<T extends string>({ value, options, onChange, label, rawDigits }: { value: T; options: SegOption<T>[]; onChange: (v: T) => void; label?: string; rawDigits?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="seg" data-raw-digits={rawDigits ? "1" : undefined}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
