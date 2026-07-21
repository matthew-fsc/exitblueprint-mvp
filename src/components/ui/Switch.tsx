import { useId, type ReactNode } from 'react';

// An on/off slider for a single boolean that takes effect immediately — a filter
// ("Show archived"), a setting, a feature flag. It's the modern read for binary
// state where a checkbox would imply "select this item in a set"; reach for a
// checkbox when the user is picking items or acknowledging a form field, and a
// Switch when they're flipping one thing on or off.
//
// Renders a real <button role="switch">, so it's keyboard- and screen-reader-
// native out of the box (Space/Enter toggles; aria-checked announces state).
// A visible label is associated via aria-labelledby (and a hint via
// aria-describedby); with no label, pass ariaLabel so the control is still
// named. Purely controlled: the parent owns the boolean.
export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
  id,
  size = 'md',
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  id?: string;
  size?: 'sm' | 'md';
  // Required when there's no visible label, so the control is still named.
  ariaLabel?: string;
}) {
  const uid = useId();
  const labelId = label != null ? `${id ?? uid}-label` : undefined;
  const hintId = hint != null ? `${id ?? uid}-hint` : undefined;

  const control = (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label == null ? ariaLabel : undefined}
      aria-labelledby={labelId}
      aria-describedby={hintId}
      disabled={disabled}
      className={`switch${size === 'sm' ? ' switch-sm' : ''}${checked ? ' switch-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" aria-hidden />
    </button>
  );

  if (label == null && hint == null) return control;

  return (
    <span className="switch-field">
      {control}
      <span className="switch-text">
        {label != null && (
          <span id={labelId} className="switch-label">
            {label}
          </span>
        )}
        {hint != null && (
          <span id={hintId} className="switch-hint">
            {hint}
          </span>
        )}
      </span>
    </span>
  );
}
