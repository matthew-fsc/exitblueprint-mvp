// ScannerAdapter: the pluggable seam for the virus-scan stage of the document
// pipeline. NO scanner vendor is hard-coded — the concrete adapter is chosen at
// runtime (resolveScanner), mirroring the ParserAdapter/StorageAdapter seams.
// The beta ships the no-op scanner (uploads are from trusted advisors); R5 wires
// a real clamd. Scanning runs on the in-memory PLAINTEXT buffer BEFORE the bytes
// are ever stored (server/documents/pipeline.ts), so infected content is never
// persisted. Fail-closed: a configured-but-unreachable scanner rejects the upload
// rather than silently accepting unscanned bytes.
import net from 'node:net';

// Maps 1:1 to documents.scan_status (pending is the pre-scan default, set at
// insert; a scanner only ever reports one of these three).
export type ScanVerdict = 'clean' | 'infected' | 'skipped';

export interface ScanInput {
  bytes: Buffer;
  filename: string;
  mimeType: string;
}

export interface ScanResult {
  status: ScanVerdict;
  scannerName: string;
  signature?: string | null; // the matched malware signature, when infected
}

export interface ScannerAdapter {
  readonly name: string;
  scan(input: ScanInput): Promise<ScanResult>;
}

// The default: no scanning. Recorded honestly as 'skipped' (never 'clean'), which
// is exactly the behavior the beta pipeline had inline before this seam existed.
export class NoopScanner implements ScannerAdapter {
  readonly name = 'noop';
  async scan(): Promise<ScanResult> {
    return { status: 'skipped', scannerName: this.name };
  }
}

// Fixture scanner for offline tests (like FixtureParserAdapter): a filename
// containing "eicar" is reported infected, everything else clean. Lets the full
// infected → rejected pipeline branch be exercised with no clamd running.
export class FixtureScanner implements ScannerAdapter {
  readonly name = 'fixture';
  async scan(input: ScanInput): Promise<ScanResult> {
    if (/eicar/i.test(input.filename)) {
      return { status: 'infected', scannerName: this.name, signature: 'Fixture.EICAR-Test' };
    }
    return { status: 'clean', scannerName: this.name };
  }
}

// Real scanner: streams the bytes to a clamd daemon over its INSTREAM protocol.
// Host/port from EB_CLAMD_HOST / EB_CLAMD_PORT (default 3310). No npm dependency —
// the protocol is a few framed writes and one line back.
export class ClamAVScanner implements ScannerAdapter {
  readonly name = 'clamav';
  private readonly host = process.env.EB_CLAMD_HOST || '127.0.0.1';
  private readonly port = Number(process.env.EB_CLAMD_PORT || 3310);
  private readonly timeoutMs = Number(process.env.EB_CLAMD_TIMEOUT_MS || 30_000);

  async scan(input: ScanInput): Promise<ScanResult> {
    const reply = await this.instream(input.bytes);
    // clamd replies "stream: OK" (clean) or "stream: <sig> FOUND" (infected).
    if (/\bOK\b/.test(reply) && !/FOUND/.test(reply)) {
      return { status: 'clean', scannerName: this.name };
    }
    const m = reply.match(/stream:\s*(.+?)\s+FOUND/);
    if (m) return { status: 'infected', scannerName: this.name, signature: m[1] };
    // Any other reply (ERROR, unexpected) is treated as a failure → fail-closed.
    throw new Error(`clamd returned an unexpected reply: ${reply.trim() || '(empty)'}`);
  }

  private instream(bytes: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      let settled = false;
      const done = (err: Error | null, reply?: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(reply ?? '');
      };
      socket.setTimeout(this.timeoutMs);
      socket.on('timeout', () => done(new Error('clamd connection timed out')));
      socket.on('error', (e) => done(e));
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
      socket.on('connect', () => {
        // zINSTREAM: null-terminated command, then length-prefixed chunks, then a
        // zero-length chunk to signal end of stream.
        socket.write('zINSTREAM\0');
        const size = Buffer.allocUnsafe(4);
        size.writeUInt32BE(bytes.length, 0);
        socket.write(size);
        socket.write(bytes);
        const terminator = Buffer.allocUnsafe(4);
        terminator.writeUInt32BE(0, 0);
        socket.write(terminator);
      });
    });
  }
}

// Resolve the active scanner without hard-coding a vendor. EB_SCANNER selects it;
// unset → noop (the beta default). Unknown values throw so a misconfiguration is
// loud rather than silently degrading to no scanning.
export function resolveScanner(): ScannerAdapter {
  const which = (process.env.EB_SCANNER ?? 'noop').toLowerCase();
  switch (which) {
    case 'noop':
      return new NoopScanner();
    case 'fixture':
      return new FixtureScanner();
    case 'clamav':
      return new ClamAVScanner();
    default:
      throw new Error(`unknown EB_SCANNER '${which}'; unset EB_SCANNER to skip scanning`);
  }
}
