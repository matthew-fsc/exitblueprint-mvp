import { useState } from 'react';

// A money field that displays grouped thousands ("1,800,000") while editing and
// reports the plain numeric value. Advisors read columns of figures; raw digit
// runs read as unfinished. Uncontrolled by default (mirrors the valuation form's
// defaultValue + commit-on-blur pattern): pass initial, receive the number on
// commit. Set live to also fire onCommit on every keystroke for controlled use.
function group(digits: string): string {
  if (!digits) return '';
  return Number(digits).toLocaleString('en-US');
}

export function MoneyInput({
  initial,
  onCommit,
  placeholder,
  live = false,
  ariaLabel,
  id,
}: {
  initial?: number | string | null;
  onCommit: (value: number | null) => void;
  placeholder?: string;
  live?: boolean;
  ariaLabel?: string;
  id?: string;
}) {
  const seed = initial === null || initial === undefined || initial === '' ? '' : String(initial).replace(/[^\d]/g, '');
  const [display, setDisplay] = useState(group(seed));

  const handleChange = (raw: string) => {
    const digits = raw.replace(/[^\d]/g, '');
    setDisplay(group(digits));
    if (live) onCommit(digits === '' ? null : Number(digits));
  };

  return (
    <span className="money-input">
      <span className="money-prefix" aria-hidden>$</span>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={ariaLabel}
        value={display}
        placeholder={placeholder}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => {
          const digits = display.replace(/[^\d]/g, '');
          if (!live) onCommit(digits === '' ? null : Number(digits));
        }}
      />
    </span>
  );
}
