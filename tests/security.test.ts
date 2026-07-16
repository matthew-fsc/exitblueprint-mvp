// Beta Requirement 5 (encryption, signed URLs, audit log) + Requirement 6
// (usage events). Crypto/signed-URL are pure and always run; audit + usage need
// a migrated DB (DATABASE_URL) and are skipped otherwise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { decryptBytes, encryptBytes } from '../server/documents/crypto';
import { signDocumentToken, verifyDocumentToken } from '../server/documents/signed-url';
import { acceptAgreement } from './helpers';
import { handleFunctionCall, type FunctionContext } from '../server/functions';

describe('document encryption at rest (R5)', () => {
  it('round-trips bytes and produces a different ciphertext each time', () => {
    const plain = Buffer.from('sensitive financials — EBITDA 1,000,000');
    const a = encryptBytes(plain);
    const b = encryptBytes(plain);
    expect(a.equals(plain)).toBe(false); // not stored in the clear
    expect(a.equals(b)).toBe(false); // random IV per encryption
    expect(decryptBytes(a).equals(plain)).toBe(true);
    expect(decryptBytes(b).equals(plain)).toBe(true);
  });

  it('rejects a tampered envelope (GCM auth tag)', () => {
    const env = encryptBytes(Buffer.from('x'));
    env[env.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => decryptBytes(env)).toThrow();
  });
});

describe('signed document URLs (R5)', () => {
  const doc = '11111111-1111-1111-1111-111111111111';
  it('verifies a fresh token for the same document', () => {
    const { token } = signDocumentToken(doc, 300);
    expect(verifyDocumentToken(doc, token)).toBe(true);
  });
  it('rejects a token for a different document', () => {
    const { token } = signDocumentToken(doc, 300);
    expect(verifyDocumentToken('22222222-2222-2222-2222-222222222222', token)).toBe(false);
  });
  it('rejects an expired token and garbage', () => {
    const { token } = signDocumentToken(doc, -1); // already expired
    expect(verifyDocumentToken(doc, token)).toBe(false);
    expect(verifyDocumentToken(doc, 'not-a-token')).toBe(false);
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('audit log + usage events (DB)', () => {
  let pool: pg.Pool;
  let service: pg.Client;
  let firmId: string;
  let otherFirmId: string;
  let advisorUserId: string;
  let otherAdvisorUserId: string;
  let engagementId: string;

  const asUserWith =
    (claims: Record<string, unknown>) =>
    async <T>(fn: (db: pg.ClientBase) => Promise<T>): Promise<T> => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        await c.query('set local role authenticated');
        const out = await fn(c);
        await c.query('commit');
        return out;
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    };
  const ctxFor = (userId: string): FunctionContext => ({
    userId,
    asUser: (fn) => asUserWith({ sub: userId, role: 'authenticated' })(fn),
    service,
  });
  const mkUser = async (email: string) =>
    (await service.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [email]))
      .rows[0].id as string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    service = new pg.Client({ connectionString: url });
    await service.connect();
    firmId = (await service.query(`insert into firms (name) values ('Sec Firm') returning id`)).rows[0].id;
    otherFirmId = (await service.query(`insert into firms (name) values ('Sec Other') returning id`)).rows[0].id;
    advisorUserId = await mkUser('sec.adv@test.co');
    otherAdvisorUserId = await mkUser('sec.other@test.co');
    await service.query(
      `insert into profiles (user_id, firm_id, role, full_name) values ($1,$2,'advisor','A'),($3,$4,'advisor','B')`,
      [advisorUserId, firmId, otherAdvisorUserId, otherFirmId],
    );
    const companyId = (await service.query(`insert into companies (firm_id, name) values ($1,'Sec Co') returning id`, [firmId])).rows[0].id;
    engagementId = (await service.query(`insert into engagements (firm_id, company_id) values ($1,$2) returning id`, [firmId, companyId])).rows[0].id;
    await acceptAgreement(service, engagementId);
  });

  afterAll(async () => {
    if (service) {
      for (const t of ['usage_events', 'data_access_log', 'document_fields', 'document_blobs', 'documents']) {
        await service.query(`delete from ${t} where firm_id = any($1)`, [[firmId, otherFirmId]]);
      }
      await service.query(`delete from engagement_agreements where firm_id = $1`, [firmId]);
      await service.query(`delete from engagements where firm_id = $1`, [firmId]);
      await service.query(`delete from agreement_versions where firm_id = $1`, [firmId]);
      await service.query(`delete from companies where firm_id = $1`, [firmId]);
      await service.query(`delete from profiles where firm_id = any($1)`, [[firmId, otherFirmId]]);
      await service.query(`delete from auth.users where id = any($1)`, [[advisorUserId, otherAdvisorUserId]]);
      await service.query(`delete from firms where id = any($1)`, [[firmId, otherFirmId]]);
      await service.end();
    }
    if (pool) await pool.end();
  });

  it('reading a document writes a data_access_log entry (R5)', async () => {
    const up = await handleFunctionCall(
      'upload-document',
      {
        engagement_id: engagementId,
        filename: 'f.pdf',
        mime_type: 'application/pdf',
        content_base64: Buffer.from('%PDF-1.4 secret').toString('base64'),
      },
      ctxFor(advisorUserId),
    );
    const docId = (up.kind === 'json' && (up.body as { document_id: string }).document_id) as string;
    await handleFunctionCall('get-document', { document_id: docId }, ctxFor(advisorUserId));
    const log = await service.query(
      `select action from data_access_log where resource_id = $1 and action = 'document.read'`,
      [docId],
    );
    expect(log.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('the stored blob is encrypted at rest (R5)', async () => {
    const row = (
      await service.query(`select bytes, enc_algo from document_blobs where firm_id = $1 limit 1`, [firmId])
    ).rows[0];
    expect(row.enc_algo).toBe('aes-256-gcm');
    expect((row.bytes as Buffer).includes(Buffer.from('secret'))).toBe(false); // not plaintext
  });

  it('usage events are firm-isolated and reconstruct a stalled session (R6)', async () => {
    // Firm A advisor emits a journey that stalls in intake (no 'assessment_submitted').
    await asUserWith({ sub: advisorUserId, role: 'authenticated' })(async (c) => {
      const seq = ['engagement_started', 'assessment_started'];
      for (let i = 0; i < seq.length; i++) {
        await c.query(
          `insert into usage_events (firm_id, event_type, event_name, session_id, engagement_id, occurred_at)
           values ($1, 'assessment', $2, 'sess-1', $3, now() + ($4 || ' seconds')::interval)`,
          [firmId, seq[i], engagementId, i],
        );
      }
    });
    // Firm B advisor emits their own event.
    await asUserWith({ sub: otherAdvisorUserId, role: 'authenticated' })(async (c) => {
      await c.query(
        `insert into usage_events (firm_id, event_type, event_name, session_id) values ($1,'report','report_downloaded','sess-b')`,
        [otherFirmId],
      );
    });

    // Firm A advisor reads only their firm's stream.
    const seen = await asUserWith({ sub: advisorUserId, role: 'authenticated' })((c) =>
      c.query(`select event_name from usage_events order by occurred_at`),
    );
    const names = seen.rows.map((r) => r.event_name);
    expect(names).toContain('assessment_started');
    expect(names).not.toContain('report_downloaded'); // firm B isolated

    // Reconstruct the stall: the session's last event is the intake start.
    const last = await service.query(
      `select event_name from usage_events where session_id = 'sess-1' order by occurred_at desc limit 1`,
    );
    expect(last.rows[0].event_name).toBe('assessment_started');
  });
});
