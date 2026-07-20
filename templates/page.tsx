// Copy to: src/pages/<Name>Page.tsx, then register the route in src/App.tsx under
// the right guard (RequireAdvisor / RequireStaff / RequireOwner).
// Design system: docs/26. Never raw snake_case / raw integers / hand-rolled tables.
import { useParams } from 'react-router-dom';
import {
  AsyncBoundary,
  EmptyState,
  EngagementNav,
  LoadingState,
  PageHeader,
  SectionCard,
} from '../components/ui';
import { useAsyncAction } from '../lib/useAsyncAction';
import { fmtCurrency } from '../lib/format';

export default function <Name>Page() {
  const { engagementId } = useParams();
  // const dataQ = use<Name>(engagementId);
  const { busy, run } = useAsyncAction();

  const doThing = () =>
    run(async () => {
      /* await invokeFunction('<name>', { engagement_id: engagementId }); */
    }, { success: '<Done>' });

  return (
    <div className="stack-lg">
      <PageHeader title="<Title>" subtitle="<one line>" />
      {engagementId && <EngagementNav engagementId={engagementId} />}

      <SectionCard
        title="<Section>"
        action={<button disabled={busy} onClick={doThing}>{busy ? 'Working…' : '<Action>'}</button>}
      >
        {/* The loading → error → empty → content ladder in one wrapper (docs/26
            §Loading & error states). ErrorState humanizes DB/auth failures and
            wires retry to a refetch. Swap the placeholder below for:
            <AsyncBoundary query={dataQ} variant="section"
              isEmpty={(d) => !d} empty={<EmptyState title="Nothing yet" />}>
              {(d) => <>{fmtCurrency(d.value)}</>}
            </AsyncBoundary> */}
        <LoadingState variant="section" lines={4} />
      </SectionCard>
    </div>
  );
}
