import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { installationCopy, serveInstallers } from './winget-loopback.mjs';

const payload = Buffer.from('verified installer fixture');
const asset = { name: 'PwrGit-0.35.0-windows-x64-setup.exe', url: 'https://github.com/pwrdrvr/PwrGit/releases/download/v0.35.0/PwrGit-0.35.0-windows-x64-setup.exe', size: payload.length, digest: `sha256:${createHash('sha256').update(payload).digest('hex')}` };
test('installation copies change only approved installer URLs and refuse other hosts', () => {
  const text = `PackageVersion: 0.35.0\n  InstallerUrl: ${asset.url}\n  InstallerSha256: ${asset.digest.slice(7).toUpperCase()}\n`;
  expect(installationCopy(text, [asset], 'http://127.0.0.1:4567')).toBe(text.replace(asset.url, `http://127.0.0.1:4567/${asset.name}`));
  expect(() => installationCopy(text.replace(asset.url, 'https://example.com/installer.exe'), [asset], 'http://127.0.0.1:4567')).toThrow('unverified');
  expect(() => installationCopy(text, [asset], 'https://example.com')).toThrow('loopback');
});
test('the mirror serves verified bytes with ranges and refuses corrupted inputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pwrgit-mirror-'));
  let server;
  try {
    mkdirSync(join(dir, 'downloads'));
    writeFileSync(join(dir, 'downloads', asset.name), payload);
    const result = await serveInstallers(dir, [asset]);
    server = result.server;
    const response = await fetch(`${result.base}/${asset.name}`, { headers: { Range: 'bytes=1-4' } });
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload.subarray(1, 5));
    expect((await fetch(`${result.base}/other.exe`)).status).toBe(404);
    expect((await fetch(`${result.base}/${asset.name}`, { headers: { Range: 'bytes=999-1000' } })).status).toBe(416);
    writeFileSync(join(dir, 'downloads', asset.name), 'corrupt');
    await expect(serveInstallers(dir, [asset])).rejects.toThrow('checksum');
  } finally {
    if (server) await new Promise((done) => { server.closeAllConnections(); server.close(done); });
    rmSync(dir, { recursive: true, force: true });
  }
});
