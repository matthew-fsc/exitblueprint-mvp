import { useLocation, Navigate } from 'react-router-dom';
import { SignUp } from '@clerk/react';
import { isClerkStack } from '../lib/supabase';
import { ThemeToggle } from '../lib/theme';
import { useClerkAppearance } from '../lib/clerkAppearance';

// Sign-up is a Clerk-only surface: it renders Clerk's hosted <SignUp> inside our
// own app chrome, themed to match (dark/light) via the shared appearance so it
// no longer drops a default Clerk card onto a themed page. Off the Clerk stack
// (local dev emulator / unconfigured deploy) there is no self-service sign-up, so
// send the user to the login screen, which explains the situation.
export default function SignUpPage() {
  const location = useLocation();
  const appearance = useClerkAppearance();

  // Preserve the protected URL the user was bounced from, if any, so sign-up
  // returns them there just like sign-in does.
  const from = (location.state as { from?: { pathname?: string; search?: string } } | null)?.from;
  const returnTo = from?.pathname ? `${from.pathname}${from.search ?? ''}` : '/';

  if (!isClerkStack) {
    return <Navigate to="/login" replace />;
  }

  return (
    <main className="login-page">
      <div className="login-topline">
        <ThemeToggle />
      </div>
      <SignUp routing="hash" signInUrl="/login" forceRedirectUrl={returnTo} appearance={appearance} />
    </main>
  );
}
