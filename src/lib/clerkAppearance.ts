import { useEffect, useState } from 'react';
import { useTheme } from './theme';

// Read the app's own CSS tokens for the current theme and hand them to Clerk's
// hosted components (<SignIn> / <SignUp>) as appearance variables, so the widgets
// match the app chrome (and follow the dark/light toggle) instead of dropping a
// default-light Clerk card into a themed page. Element overrides use live var()
// so they track the theme too. Shared by every Clerk surface so sign-in and
// sign-up never diverge.
export function clerkAppearance() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    variables: {
      colorPrimary: v('--accent'),
      colorBackground: v('--surface-1'),
      colorText: v('--text-primary'),
      colorTextSecondary: v('--text-secondary'),
      colorInputBackground: v('--input-bg'),
      colorInputText: v('--text-primary'),
      colorNeutral: v('--text-primary'),
      borderRadius: v('--radius'),
    },
    elements: {
      card: {
        background: 'var(--surface-1)',
        border: '1px solid var(--border-strong)',
        boxShadow: 'var(--shadow-lift)',
      },
      headerTitle: { color: 'var(--text-primary)' },
      headerSubtitle: { color: 'var(--text-secondary)' },
      formFieldInput: {
        background: 'var(--input-bg)',
        borderColor: 'var(--input-border)',
        color: 'var(--text-primary)',
      },
      footerActionLink: { color: 'var(--accent)' },
    },
  };
}

// Recompute Clerk's appearance after the theme attribute is applied. A rAF
// ensures we read the tokens once the new data-theme has committed to the DOM.
export function useClerkAppearance() {
  const { theme } = useTheme();
  const [appearance, setAppearance] = useState(clerkAppearance);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAppearance(clerkAppearance()));
    return () => cancelAnimationFrame(id);
  }, [theme]);
  return appearance;
}
