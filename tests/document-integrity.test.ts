// Pure-logic unit tests for the document-ingestion integrity helpers
// (server/documents/pipeline.ts). No DB — these run everywhere, including local
// dev where DATABASE_URL is unset.
import { afterEach, describe, expect, it } from 'vitest';
import {
  sanitizeFilename,
  scanVerdictAllowsServe,
  sha256Hex,
  signatureMismatch,
} from '../server/documents/pipeline';

describe('sanitizeFilename', () => {
  it('drops directory portions (path traversal)', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\a\\secret.pdf')).toBe('secret.pdf');
  });
  it('strips CR/LF and quotes (header injection)', () => {
    expect(sanitizeFilename('a"b.pdf')).toBe('ab.pdf');
    expect(sanitizeFilename('a\r\nContent-Length: 0\r\n.pdf')).toBe('aContent-Length: 0.pdf');
  });
  it('falls back to a safe default when nothing survives', () => {
    expect(sanitizeFilename('')).toBe('document');
    expect(sanitizeFilename('/')).toBe('document');
  });
  it('leaves a normal filename intact', () => {
    expect(sanitizeFilename('financials.pdf')).toBe('financials.pdf');
    expect(sanitizeFilename('roster.csv')).toBe('roster.csv');
  });
});

describe('scanVerdictAllowsServe', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });
  it('always allows clean, even in production', () => {
    process.env.NODE_ENV = 'production';
    expect(scanVerdictAllowsServe('clean')).toBe(true);
  });
  it('allows skipped outside production, blocks it in production', () => {
    process.env.NODE_ENV = 'test';
    expect(scanVerdictAllowsServe('skipped')).toBe(true);
    process.env.NODE_ENV = 'production';
    expect(scanVerdictAllowsServe('skipped')).toBe(false);
  });
  it('never allows infected or pending', () => {
    process.env.NODE_ENV = 'test';
    expect(scanVerdictAllowsServe('infected')).toBe(false);
    expect(scanVerdictAllowsServe('pending')).toBe(false);
  });
});

describe('signatureMismatch', () => {
  const pdf = Buffer.from('%PDF-1.4 hello');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  const text = Buffer.from('reconciliations');

  it('passes bytes that match their claimed extension', () => {
    expect(signatureMismatch('a.pdf', pdf)).toBe(false);
    expect(signatureMismatch('a.png', png)).toBe(false);
    expect(signatureMismatch('a.jpeg', jpeg)).toBe(false);
    expect(signatureMismatch('a.xlsx', zip)).toBe(false);
  });

  it('passes signatureless payloads regardless of the claimed extension (CI-safe)', () => {
    // A short non-binary body under a .pdf name (as the data-room / evidence
    // fixtures upload) matches NO known signature → allowed.
    expect(signatureMismatch('recs.pdf', text)).toBe(false);
    // CSV / TXT have no signature and are always allowed.
    expect(signatureMismatch('roster.csv', Buffer.from('name,title'))).toBe(false);
    expect(signatureMismatch('notes.txt', pdf)).toBe(false);
  });

  it('rejects a positive mismatch: bytes are a DIFFERENT known type', () => {
    expect(signatureMismatch('image.pdf', png)).toBe(true); // PNG wearing .pdf
    expect(signatureMismatch('doc.png', pdf)).toBe(true); // PDF wearing .png
    expect(signatureMismatch('sheet.pdf', zip)).toBe(true); // ZIP/OOXML wearing .pdf
  });
});

describe('sha256Hex', () => {
  it('is stable and content-addressed', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex(Buffer.from('abc')));
    expect(sha256Hex(Buffer.from('abc'))).not.toBe(sha256Hex(Buffer.from('abd')));
  });
});
