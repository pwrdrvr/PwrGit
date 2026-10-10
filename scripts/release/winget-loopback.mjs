#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { distribution, downloadAssets, hashFile, renderManifests, selectAssets, stableVersion } from '../package-manager-release.mjs';
import { makeApi } from '../lib/distribution-api.mjs';
import { isCliEntrypoint } from '../lib/cli-entrypoint.mjs';

export async function prepareBaseline(dir, { api = makeApi(), fetch } = {}) {
  const status = JSON.parse(readFileSync(join(dir, 'distribution-status.json'), 'utf8'));
  const assets = [status.assets.find(({ name }) => name.endsWith('.exe'))];
  const previous = status.winget.version;
  if (previous && previous !== status.version) {
    const release = await api(`repos/${distribution.repo}/releases/tags/v${previous}`);
    if (stableVersion(release) !== previous) throw new Error('Unexpected upgrade baseline version');
    const selected = selectAssets(release);
    const installer = selected.find(({ name }) => name.endsWith('.exe'));
    if (status.winget.assets.length !== 1 || status.winget.assets[0].url !== installer.url || status.winget.assets[0].digest !== installer.digest) {
      throw new Error('Indexed upgrade baseline differs from published signed installer');
    }
    await downloadAssets([installer], join(dir, 'downloads'), { fetch });
    assets.push(installer);
    for (const [path, text] of Object.entries(renderManifests(release, selected))) {
      if (!path.startsWith('manifests/')) continue;
      const file = join(dir, path);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, text);
    }
  }
  writeFileSync(join(dir, 'winget-installers.json'), JSON.stringify(assets));
}

export function installationCopy(text, assets, base) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Installer mirror must use loopback');
  return text.split(/(?<=\n)/).map((line) => {
    const match = line.match(/^(\s*InstallerUrl: )([^\s]+)(\r?\n)?$/);
    if (!match) {
      if (line.trimStart().startsWith('InstallerUrl:')) throw new Error('Unexpected installer URL layout');
      return line;
    }
    const asset = assets.find(({ url }) => url === match[2]);
    if (!asset) throw new Error('Manifest refers to an unverified installer');
    return `${match[1]}${base}/${asset.name}${match[3] ?? ''}`;
  }).join('');
}

export async function serveInstallers(dir, assets) {
  const files = new Map();
  for (const asset of assets) {
    const file = join(dir, 'downloads', asset.name);
    const actual = await hashFile(file);
    if (actual.digest !== asset.digest || actual.size !== asset.size) throw new Error('Installer mirror checksum mismatch');
    files.set(`/${asset.name}`, { file, asset });
  }
  const server = createServer((req, res) => {
    const entry = files.get(req.url);
    if (!entry || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end(); return; }
    let start = 0;
    let end = entry.asset.size - 1;
    let status = 200;
    if (req.headers.range) {
      const range = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
      if (!range) { res.writeHead(416).end(); return; }
      start = Number(range[1]);
      end = range[2] ? Number(range[2]) : end;
      if (start > end || end >= entry.asset.size) { res.writeHead(416).end(); return; }
      status = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${entry.asset.size}`);
    }
    res.writeHead(status, { 'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' });
    console.log(`${req.method} ${req.url} ${status}`);
    if (req.method === 'HEAD') res.end();
    else {
      const stream = createReadStream(entry.file, { start, end });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function runCli([command, dir, ready] = process.argv.slice(2)) {
  if (command === 'prepare') { await prepareBaseline(dir); return; }
  if (command !== 'serve' || !ready) throw new Error('Usage: winget-loopback.mjs prepare <dir> | serve <dir> <ready>');
  const assets = JSON.parse(readFileSync(join(dir, 'winget-installers.json'), 'utf8'));
  const status = JSON.parse(readFileSync(join(dir, 'distribution-status.json'), 'utf8'));
  const { server, base } = await serveInstallers(dir, assets);
  try {
    for (const asset of assets) {
      const version = asset.name.match(/^PwrGit-(\d+\.\d+\.\d+)-windows-x64-setup.exe$/)?.[1];
      if (!version) throw new Error('Unexpected installer name');
      const manifestDir = join(distribution.wingetPath, version);
      for (const suffix of ['', '.installer', '.locale.en-US']) {
        const path = join(manifestDir, `${distribution.wingetId}${suffix}.yaml`);
        const text = readFileSync(join(dir, path), 'utf8');
        const file = join(dir, 'installation', path);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, installationCopy(text, assets, base));
      }
    }
    writeFileSync(ready, JSON.stringify({ base, version: status.version }));
  } catch (error) { server.close(); throw error; }
  process.on('SIGTERM', () => server.close());
}
if (isCliEntrypoint(import.meta.url)) runCli().catch((error) => { console.error(error.message); process.exitCode = 1; });
