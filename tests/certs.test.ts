import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { certsDirCandidates, isCertificateErrorMessage } from '../src/max/ca.js';
import { outageCause } from '../src/server/maxSession.js';

describe('certs/ lookup', () => {
  it('tries the start folder first, then the folders around the code', () => {
    const dirs = certsDirCandidates('/home/u', '/home/u/MaxBridge/dist');
    expect(dirs[0]).toBe(path.join('/home/u', 'certs'));
    expect(dirs).toContain(path.join('/home/u/MaxBridge', 'certs')); // dist/ of a build
    expect(certsDirCandidates('/x', 'C:/T/Telemax/app/dist')).toContain(path.join('C:/T/Telemax', 'certs')); // the Windows build
  });

  it('finds the real certs from a foreign start folder', async () => {
    const { existsSync } = await import('node:fs');
    const dirs = certsDirCandidates('/nowhere', path.resolve('src/max'));
    expect(dirs.some((d) => existsSync(path.join(d, 'russian_trusted_root_ca.crt')))).toBe(true);
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
