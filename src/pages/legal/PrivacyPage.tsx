import { LegalDocPage } from './LegalDocPage';
import { privacyDoc } from './content';

// Public Privacy Policy page (no auth). DRAFT scaffold — see content.ts.
export default function PrivacyPage() {
  return <LegalDocPage doc={privacyDoc} />;
}
