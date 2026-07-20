// R5 secure document storage: the object-storage backend, the virus-scan seam,
// scan-before-store, and the upload allow-list. The adapter-selection and scanner
// tests are pure (no DB); the pipeline tests need a migrated DB (DATABASE_URL) and
// skip otherwise. Defaults (EB_STORAGE=db, EB_SCANNER unset) are unchanged, so the
// rest of the suite is untouched — these prove only the new opt-in behavior.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { acceptAgreement } from './helpers';
import {
  DbBlobStorage,
  SupabaseStorage,
  resolveStorage,
} from '../server/documents/storage';
import {
  ClamAVScanner,
  FixtureScanner,
  NoopScanner,
  resolveScanner,
} from '../server/documents/scanner';
import { uploadDocument } from '../server/documents/pipeline';

// Save/restore an env var around a single assertion so tests never leak config.
function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
  const out = fn();
  if (out instanceof Promise) return out.finally(restore);
  restore();
  return out;
}

describe('R5 storage backend selection (pure)', () => {
  it('defaults to the DB backend', () => {
    withEnv({ EB_STORAGE: undefined }, () => {
      const s = resolveStorage();
      expect(s).toBeInstanceOf(DbBlobStorage);
      expect(s.name).toBe('db');
    });
  });

  it('selects the Supabase backend when EB_STORAGE=supabase', () => {
    withEnv({ EB_STORAGE: 'supabase' }, () => {
      expect(resolveStorage()).toBeInstanceOf(SupabaseStorage);
    });
  });

  it('throws loudly on an unknown backend', () => {
    withEnv({ EB_STORAGE: 'nope' }, () => {
      expect(() => resolveStorage()).toThrow(/not implemented/);
    });
  });

  it('Supabase backend fails with a clear message when its keys are missing', async () => {
    await withEnv(
      { EB_STORAGE: 'supabase', SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined },
      async () => {
        const s = new SupabaseStorage();
        await expect(
          s.put(null as never, { documentId: 'd', firmId: 'f', bytes: Buffer.from('x') }),
        ).rejects.toThrow(/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
      },
    );
  });
});

describe('R5 scanner selection + verdicts (pure)', () => {
  it('defaults to the no-op scanner (records skipped)', async () => {
    await withEnv({ EB_SCANNER: undefined }, async () => {
      const s = resolveScanner();
      expect(s).toBeInstanceOf(NoopScanner);
      const r = await s.scan({ bytes: Buffer.from('x'), filename: 'a.pdf', mimeType: 'application/pdf' });
      expect(r.status).toBe('skipped');
    });
  });

  it('selects fixture and clamav backends by env', () => {
    withEnv({ EB_SCANNER: 'fixture' }, () => expect(resolveScanner()).toBeInstanceOf(FixtureScanner));
    withEnv({ EB_SCANNER: 'clamav' }, () => expect(resolveScanner()).toBeInstanceOf(ClamAVScanner));
    withEnv({ EB_SCANNER: 'nope' }, () => expect(() => resolveScanner()).toThrow(/unknown EB_SCANNER/));
  });

  it('fixture scanner flags an eicar-named file infected, others clean', async () => {
    const s = new FixtureScanner();
    const bad = await s.scan({ bytes: Buffer.from('x'), filename: 'eicar.pdf', mimeType: 'application/pdf' });
    expect(bad.status).toBe('infected');
    const good = await s.scan({ bytes: Buffer.from('x'), filename: 'report.pdf', mimeType: 'application/pdf' });
    expect(good.status).toBe('clean');
  });
});

describe('R5 upload allow-list (pure — rejects before any DB access)', () => {
  it('rejects a disallowed file type by extension', async () => {
    // A disallowed extension is rejected before the pipeline touches the db, so a
    // null db is never dereferenced.
    await expect(
      uploadDocument(null as never, 'firm', null, {
        engagement_id: 'e',
        filename: 'malware.exe',
        mime_type: 'application/octet-stream',
        content_base64: Buffer.from('x').toString('base64'),
      }),
    ).rejects.toThrow(/not allowed/);
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('R5 scan-before-store pipeline (DB)', () => {
  let service: pg.Client;
  let firmId: string;
  let engagementId: string;

  beforeAll(async () => {
    service = new pg.Client({ connectionString: url });
    await service.connect();
    firmId = (await service.query(`insert into firms (name) values ('R5 Firm') returning id`)).rows[0].id;
    const companyId = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'R5 Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [
        firmId,
        companyId,
      ])
    ).rows[0].id;
    await acceptAgreement(service, engagementId);
  });

  afterEach(() => {
    delete process.env.EB_SCANNER;
  });

  afterAll(async () => {
    if (!service) return;
    await service.query(`delete from document_fields where firm_id = $1`, [firmId]);
    await service.query(`delete from document_blobs where firm_id = $1`, [firmId]);
    await service.query(`delete from documents where firm_id = $1`, [firmId]);
    await service.query(`delete from engagement_agreements where firm_id = $1`, [firmId]);
    await service.query(`delete from engagements where firm_id = $1`, [firmId]);
    await service.query(`delete from agreement_versions where firm_id = $1`, [firmId]);
    await service.query(`delete from companies where firm_id = $1`, [firmId]);
    await service.query(`delete from firms where id = $1`, [firmId]);
    await service.end();
  });

  const upload = (filename: string) =>
    uploadDocument(service, firmId, null, {
      engagement_id: engagementId,
      category: 'Financials',
      filename,
      mime_type: 'application/pdf',
      content_base64: Buffer.from(`%PDF-1.4 ${filename}`).toString('base64'),
    });

  it('infected upload is rejected and NEVER stored (no blob, no fields)', async () => {
    process.env.EB_SCANNER = 'fixture';
    const r = await upload('eicar-invoice.pdf');
    expect(r.status).toBe('rejected');
    expect(r.fields_extracted).toBe(0);

    const doc = (await service.query(`select status, scan_status from documents where id = $1`, [r.document_id]))
      .rows[0];
    expect(doc).toMatchObject({ status: 'rejected', scan_status: 'infected' });
    const blobs = await service.query(`select 1 from document_blobs where document_id = $1`, [r.document_id]);
    expect(blobs.rowCount).toBe(0);
    const fields = await service.query(`select 1 from document_fields where document_id = $1`, [r.document_id]);
    expect(fields.rowCount).toBe(0);
  });

  it('clean upload passes the scan and lands in review with its bytes stored', async () => {
    process.env.EB_SCANNER = 'fixture';
    const r = await upload('financials.pdf');
    expect(r.status).toBe('in_review');

    const doc = (await service.query(`select status, scan_status from documents where id = $1`, [r.document_id]))
      .rows[0];
    expect(doc).toMatchObject({ status: 'in_review', scan_status: 'clean' });
    const blobs = await service.query(`select 1 from document_blobs where document_id = $1`, [r.document_id]);
    expect(blobs.rowCount).toBe(1);
  });
});
