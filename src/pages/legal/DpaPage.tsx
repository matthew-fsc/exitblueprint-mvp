import { LegalDocPage } from './LegalDocPage';
import { dpaDoc } from './content';

// Public Data Processing Addendum page (no auth). DRAFT scaffold — see content.ts.
export default function DpaPage() {
  return <LegalDocPage doc={dpaDoc} />;
}
