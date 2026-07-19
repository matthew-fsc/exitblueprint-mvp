// Copy to: src/pages/<Name>Page.tsx, then register the route in src/App.tsx under
// the right guard (RequireAdvisor / RequireStaff / RequireOwner).
// Design system: docs/26. Never raw snake_case / raw integers / hand-rolled tables.
import { useParams } from 'react-router-dom';
import {
  EmptyState,
  EngagementNav,
  PageHeader,
  SectionCard,
  SkeletonLines,
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
        {/* dataQ.isLoading ? <SkeletonLines lines={4} /> :
            !dataQ.data ? <EmptyState title="Nothing yet" /> :
            <>{fmtCurrency(dataQ.data.value)}</> */}
        <SkeletonLines lines={4} />
      </SectionCard>
    </div>
  );
}
