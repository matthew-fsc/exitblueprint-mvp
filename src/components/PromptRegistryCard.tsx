// Superadmin narrative-prompt editor (docs/04). Lists every bundled prompt and
// lets a platform superadmin override its body in-system (no code deploy) or
// reset it back to the shipped file. Reads/writes the platform-admin functions
// (list-prompts / set-prompt / reset-prompt); the server enforces the superadmin
// gate. The numeral firewall + rule-based fallback still guard every generation,
// so an edit can't inject invented numbers or hard-fail a document.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionCard } from './ui';
import { fmtDate } from '../lib/format';
import { invokeFunction } from '../lib/supabase';

interface PromptView {
  key: string;
  source: 'db' | 'file';
  body_md: string;
  file_body_md: string;
  updated_at: string | null;
  updated_by: string | null;
}

export function PromptRegistryCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['platform-prompts'],
    queryFn: () => invokeFunction<{ prompts: PromptView[] }>('list-prompts', {}),
  });
  const prompts = q.data?.prompts ?? [];

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const selected = prompts.find((p) => p.key === selectedKey) ?? null;

  // Default the selection to the first prompt once loaded, and load its body.
  useEffect(() => {
    if (!selectedKey && prompts.length > 0) {
      setSelectedKey(prompts[0].key);
      setDraft(prompts[0].body_md);
    }
  }, [prompts, selectedKey]);

  const pick = (key: string) => {
    setSelectedKey(key);
    setDraft(prompts.find((p) => p.key === key)?.body_md ?? '');
  };

  const save = useMutation({
    mutationFn: () => invokeFunction('set-prompt', { key: selectedKey, body_md: draft }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-prompts'] }),
  });
  const reset = useMutation({
    mutationFn: () => invokeFunction('reset-prompt', { key: selectedKey }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['platform-prompts'] });
      const fresh = await qc.getQueryData<{ prompts: PromptView[] }>(['platform-prompts']);
      const f = fresh?.prompts.find((p) => p.key === selectedKey);
      if (f) setDraft(f.body_md);
    },
  });

  const dirty = selected ? draft !== selected.body_md : false;

  return (
    <SectionCard
      title="Narrative prompts"
      subtitle="Edit the AI narrative prompts in-system. Files are the versioned default; an override applies without a deploy. The numeral firewall still fixes every figure."
    >
      {q.isLoading ? (
        <p className="muted">Loading prompts…</p>
      ) : q.isError ? (
        <p className="muted">Prompt registry unavailable (superadmin only).</p>
      ) : prompts.length === 0 ? (
        <p className="muted">No prompts found.</p>
      ) : (
        <div className="prompt-registry">
          <div className="prompt-registry-list">
            {prompts.map((p) => (
              <button
                key={p.key}
                className={`prompt-registry-item${p.key === selectedKey ? ' is-active' : ''}`}
                onClick={() => pick(p.key)}
              >
                <span className="prompt-registry-key">{p.key}</span>
                <span className={`prompt-registry-tag prompt-registry-tag-${p.source}`}>
                  {p.source === 'db' ? 'Override' : 'Default'}
                </span>
              </button>
            ))}
          </div>
          {selected && (
            <div className="prompt-registry-editor">
              <p className="muted text-sm">
                {selected.source === 'db'
                  ? `Overridden${selected.updated_by ? ` by ${selected.updated_by}` : ''}${
                      selected.updated_at ? ` · ${fmtDate(selected.updated_at)}` : ''
                    }`
                  : 'Using the bundled default.'}
              </p>
              <textarea
                className="report-editor"
                rows={18}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
              />
              <div className="prompt-registry-actions">
                <button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save override'}
                </button>
                <button
                  className="button-secondary"
                  onClick={() => reset.mutate()}
                  disabled={selected.source !== 'db' || reset.isPending}
                >
                  {reset.isPending ? 'Resetting…' : 'Reset to default'}
                </button>
                {dirty && <span className="muted text-sm">Unsaved changes</span>}
                {(save.isError || reset.isError) && (
                  <span className="prompt-registry-error text-sm">
                    {((save.error ?? reset.error) as Error)?.message ?? 'Action failed'}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
