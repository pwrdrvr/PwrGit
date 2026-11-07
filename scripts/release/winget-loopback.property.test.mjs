import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { distribution, renderManifests, selectAssets } from '../package-manager-release.mjs';
import { applyVariant, textVariant } from '../test-support/line-endings.mjs';
import { installationCopy } from './winget-loopback.mjs';

const release = fc
  .tuple(fc.nat({ max: 30 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }))
  .map((parts) => {
    const version = parts.join('.');
    const tag_name = `v${version}`;
    return {
      tag_name, draft: false, prerelease: false,
      assets: ['arm64.dmg', 'universal.dmg', 'windows-x64-setup.exe'].map((suffix, i) => {
        const name = `PwrGit-${version}-${suffix}`;
        return {
          name,
          browser_download_url: `https://github.com/${distribution.repo}/releases/download/${tag_name}/${name}`,
          size: 1,
          digest: `sha256:${String(i + 1).repeat(64)}`,
        };
      }),
    };
  });

describe('installationCopy (property)', () => {
  it('rewrites the installer URL and nothing else, keeping the manifest line endings, BOM and final newline', () => {
    fc.assert(
      fc.property(release, fc.nat({ max: 65_535 }), textVariant(), (value, port, variant) => {
        const version = value.tag_name.slice(1);
        const installer = selectAssets(value)[2];
        const asset = { url: installer.browser_download_url, name: installer.name };
        const manifests = renderManifests(value, selectAssets(value), ':ventura');
        const base = `http://127.0.0.1:${port}`;
        for (const [path, text] of Object.entries(manifests)) {
          if (!path.startsWith(`${distribution.wingetPath}/${version}/`)) continue;
          // winget reads the copy, so it must be the same file in the same
          // form, with only the URL moved to the loopback mirror.
          expect(installationCopy(applyVariant(variant, text), [asset], base)).toBe(
            applyVariant(variant, text.replace(asset.url, `${base}/${asset.name}`)),
          );
        }
      }),
    );
  });
});
