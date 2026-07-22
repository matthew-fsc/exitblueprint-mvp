// Prompt registry (server/prompt-registry.ts): the superadmin DB override layer
// over the bundled prompts/<key>.md files. Requires a migrated database
// (analytics.prompt_templates); skipped otherwise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  listPromptTemplates,
  promptFileKeys,
  resetPromptTemplate,
  resolvePromptBody,
  setPromptTemplate,
} from '../server/prompt-registry';

const url = process.env.DATABASE_URL;
const KEY = 'owner_report.v1';

describe.skipIf(!url)('prompt registry', () => {
  let db: pg.Client;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query(`delete from analytics.prompt_templates where key = $1`, [KEY]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from analytics.prompt_templates where key = $1`, [KEY]);
    await db.end();
  });

  it('lists every bundled prompt, file-sourced by default', async () => {
    const { prompts } = await listPromptTemplates(db);
    const keys = prompts.map((p) => p.key);
    expect(keys).toContain(KEY);
    expect(keys).toContain('cim.v1');
    expect(keys).toContain('diligence_simulation.v1');
    expect(prompts.every((p) => p.source === 'file')).toBe(true);
    // The bundled default is always exposed for the console to show/diff.
    expect(prompts.find((p) => p.key === KEY)?.file_body_md.length).toBeGreaterThan(0);
  });

  it('resolves the bundled file body when there is no override', async () => {
    const body = await resolvePromptBody(db, KEY);
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toBe('OVERRIDE BODY');
  });

  it('applies and then reverts a superadmin override', async () => {
    await setPromptTemplate(db, { key: KEY, body_md: 'OVERRIDE BODY' }, 'user_super');
    expect(await resolvePromptBody(db, KEY)).toBe('OVERRIDE BODY');

    const { prompts } = await listPromptTemplates(db);
    const row = prompts.find((p) => p.key === KEY);
    expect(row?.source).toBe('db');
    expect(row?.body_md).toBe('OVERRIDE BODY');
    expect(row?.updated_by).toBe('user_super');

    await resetPromptTemplate(db, { key: KEY });
    const reverted = await resolvePromptBody(db, KEY);
    expect(reverted).not.toBe('OVERRIDE BODY');
    expect(reverted.length).toBeGreaterThan(0);
  });

  it('rejects an unknown key and an empty body', async () => {
    await expect(setPromptTemplate(db, { key: 'not_a_prompt', body_md: 'x' }, null)).rejects.toThrow();
    await expect(setPromptTemplate(db, { key: KEY, body_md: '   ' }, null)).rejects.toThrow();
    // The allow-list is exactly the bundled files.
    expect(promptFileKeys()).toContain(KEY);
  });
});
