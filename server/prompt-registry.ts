// Prompt registry (docs/04). The AI prompts ship as bundled files
// (prompts/<key>.md) that are the versioned default. A platform superadmin may
// override a prompt's body in analytics.prompt_templates WITHOUT a code deploy;
// resolvePromptBody returns the DB override when present, otherwise the file.
//
// The bundled files are the allow-list: a superadmin can only override a prompt
// that ships with the build (setPromptTemplate rejects unknown keys), so the
// payload↔field-name contract each prompt depends on can't be pointed at a key
// that has no code behind it. The numeral firewall + rule-based composer (in the
// generators) are code, independent of prompt text, so an edited or empty prompt
// can never inject invented numbers or hard-fail a delivery (rules 1/2).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

// The prompt keys that ship with this build (filename stems of prompts/*.md).
// This is the allow-list for overrides and the enumeration the console lists.
export function promptFileKeys(): string[] {
  return readdirSync(promptsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -'.md'.length))
    .sort();
}

function fileBody(key: string): string {
  return readFileSync(join(promptsDir, `${key}.md`), 'utf8');
}

// Resolve a prompt body: a superadmin DB override wins; otherwise the bundled
// file. Best-effort on the DB — a missing table (pre-migration) or read error
// falls through to the file, so generation never depends on the registry.
export async function resolvePromptBody(db: pg.ClientBase, key: string): Promise<string> {
  try {
    const row = (
      await db.query(`select body_md from analytics.prompt_templates where key = $1`, [key])
    ).rows[0];
    if (row?.body_md) return row.body_md as string;
  } catch {
    // Registry absent or unreadable — fall back to the bundled file.
  }
  return fileBody(key);
}

export interface PromptTemplateView {
  key: string;
  source: 'db' | 'file'; // whether the effective body is an override or the bundled file
  body_md: string; // the effective body (override if present, else file)
  file_body_md: string; // the bundled default, always, so the console can show/diff it
  updated_at: string | null;
  updated_by: string | null;
}

// Every shipped prompt with its effective body and whether an override is active.
export async function listPromptTemplates(db: pg.ClientBase): Promise<{ prompts: PromptTemplateView[] }> {
  const keys = promptFileKeys();
  let overrides = new Map<string, { body_md: string; updated_at: string; updated_by: string | null }>();
  try {
    const rows = (
      await db.query(`select key, body_md, updated_at, updated_by from analytics.prompt_templates`)
    ).rows as { key: string; body_md: string; updated_at: string; updated_by: string | null }[];
    overrides = new Map(rows.map((r) => [r.key, r]));
  } catch {
    // Registry table absent — every prompt is file-sourced.
  }
  const prompts = keys.map((key) => {
    const file = fileBody(key);
    const ov = overrides.get(key);
    return {
      key,
      source: ov ? ('db' as const) : ('file' as const),
      body_md: ov?.body_md ?? file,
      file_body_md: file,
      updated_at: ov?.updated_at ?? null,
      updated_by: ov?.updated_by ?? null,
    };
  });
  return { prompts };
}

// Upsert a superadmin override for a shipped prompt. Rejects an unknown key (not
// a bundled prompt) and an empty body.
export async function setPromptTemplate(
  db: pg.ClientBase,
  body: Record<string, unknown>,
  updatedBy: string | null,
): Promise<{ key: string; source: 'db' }> {
  const key = typeof body.key === 'string' ? body.key : '';
  const bodyMd = typeof body.body_md === 'string' ? body.body_md : '';
  if (!promptFileKeys().includes(key)) throw new Error(`unknown prompt key: ${key || '(missing)'}`);
  if (!bodyMd.trim()) throw new Error('prompt body_md is required');
  await db.query(
    `insert into analytics.prompt_templates (key, body_md, updated_by)
     values ($1, $2, $3)
     on conflict (key) do update set body_md = excluded.body_md,
                                     updated_by = excluded.updated_by,
                                     updated_at = now()`,
    [key, bodyMd, updatedBy],
  );
  return { key, source: 'db' };
}

// Drop a superadmin override, reverting the prompt to its bundled file.
export async function resetPromptTemplate(
  db: pg.ClientBase,
  body: Record<string, unknown>,
): Promise<{ key: string; source: 'file' }> {
  const key = typeof body.key === 'string' ? body.key : '';
  if (!key) throw new Error('prompt key is required');
  await db.query(`delete from analytics.prompt_templates where key = $1`, [key]);
  return { key, source: 'file' };
}
