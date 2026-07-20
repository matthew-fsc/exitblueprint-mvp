import { LegalDocPage } from './LegalDocPage';
import { termsDoc } from './content';

// Public Terms of Service page (no auth). DRAFT scaffold — see content.ts.
export default function TermsPage() {
  return <LegalDocPage doc={termsDoc} />;
}
