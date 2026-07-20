import { DataTable, SectionCard, type Column } from '../../components/ui';
import { LegalDocPage } from './LegalDocPage';
import { subprocessorsDoc, SUBPROCESSORS, type Subprocessor } from './content';

// Public Sub-processors page (no auth). The register itself is FACTUAL — sourced
// from the real stack (CLAUDE.md, docs/13, docs/16); the surrounding document is
// a DRAFT scaffold. The table renders through the standard DataTable.
const columns: Column<Subprocessor>[] = [
  {
    key: 'name',
    header: 'Sub-processor',
    render: (r) => <strong>{r.name}</strong>,
    sortValue: (r) => r.name,
  },
  { key: 'purpose', header: 'Purpose' },
  { key: 'dataCategory', header: 'Data category' },
  { key: 'region', header: 'Region', sortValue: (r) => r.region },
];

export default function SubprocessorsPage() {
  return (
    <LegalDocPage doc={subprocessorsDoc}>
      <SectionCard
        title="Current sub-processors"
        subtitle="The third parties that process data to operate the platform."
      >
        <DataTable
          columns={columns}
          rows={SUBPROCESSORS}
          keyFor={(r) => r.name}
          initialSort={{ key: 'name', dir: 'asc' }}
        />
      </SectionCard>
    </LegalDocPage>
  );
}
