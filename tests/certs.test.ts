import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { isCertificateErrorMessage, MAX_TLS_CA } from '../src/max/ca.js';
import { RUSSIAN_CA_PEMS } from '../src/max/russianCa.generated.js';
import { outageCause } from '../src/server/maxSession.js';
import { versionDirCandidates } from '../src/bridge/version.js';
// @ts-expect-error — a plain .mjs build script, no types
import { readCertsDir } from '../scripts/gen-russian-ca.mjs';

describe('the Russian state CA, built into the bridge', () => {
  it('is exactly what certs/ holds (run scripts/gen-russian-ca.mjs after changing certs/)', () => {
    expect(RUSSIAN_CA_PEMS).toEqual(readCertsDir('certs'));
  });

  it('holds the root and the sub CA MAX presents now, and goes into the MAX trust list', () => {
    const certs = RUSSIAN_CA_PEMS.map((c) => new X509Certificate(c.pem));
    const root = certs.find((c) => c.subject.includes('CN=Russian Trusted Root CA'))!;
    expect(root).toBeDefined();
    // The 2024 sub CA (valid to 2029) — the one in MAX's chain since mid-2024, signed by the root.
    const sub2024 = certs.find((c) => c.fingerprint256 === '21:55:78:50:36:C9:00:DB:B5:F1:BB:2A:15:69:C8:0C:55:59:5B:D6:BF:94:86:7A:29:BB:DD:BC:7D:88:A3:F2');
    expect(sub2024?.verify(root.publicKey)).toBe(true);
    for (const c of RUSSIAN_CA_PEMS) expect(MAX_TLS_CA).toContain(c.pem);
  });
});

describe('VERSION lookup', () => {
  it('tries the start folder first, then the folders around the code', () => {
    const dirs = versionDirCandidates('/home/u', '/home/u/MaxBridge/dist');
    expect(dirs[0]).toBe('/home/u');
    expect(dirs).toContain(path.join('/home/u/MaxBridge'));
    expect(versionDirCandidates('/x', 'C:/T/Telemax/app/dist')).toContain(path.join('C:/T/Telemax'));
  });
});

describe('a refused certificate', () => {
  it('is told apart from a blocked handshake', () => {
    for (const m of ['unable to get local issuer certificate', 'self-signed certificate in certificate chain', 'certificate has expired', "Hostname/IP does not match certificate's altnames"]) {
      expect(isCertificateErrorMessage(m)).toBe(true);
      expect(outageCause(m)).toBe('certificate');
    }
    expect(isCertificateErrorMessage('MAX TLS handshake timed out after 15s')).toBe(false);
    expect(outageCause('MAX TLS handshake timed out after 15s')).toBe('tls');
    expect(isCertificateErrorMessage('read ECONNRESET')).toBe(false);
  });
});
