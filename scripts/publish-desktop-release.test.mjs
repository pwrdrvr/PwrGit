import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { collectAssets, expectedAssetNames, publishRelease } from "./publish-desktop-release.mjs";

const tag = "v0.18.0";
const tempDirs = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-publish-test-"));
  tempDirs.push(root);
  const macDir = join(root, "mac");
  const windowsDir = join(root, "windows");
  mkdirSync(macDir);
  mkdirSync(windowsDir);
  for (const name of expectedAssetNames(tag)) {
    const directory = name.endsWith(".exe") || name.includes("windows") || name === "latest.yml"
      ? windowsDir : macDir;
    const original = name === "PwrGit.dmg" ? "PwrGit-0.18.0-universal.dmg"
      : name === "PwrGit-arm64.dmg" ? "PwrGit-0.18.0-arm64.dmg"
        : name === "PwrGit.Setup.exe" ? "PwrGit-0.18.0-windows-x64-setup.exe" : name;
    writeFileSync(join(directory, name), original);
  }
  const notesFile = join(root, "notes.md");
  writeFileSync(notesFile, "Fixed release publishing.\n");
  return { tag, macDir, windowsDir, notesFile };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeGh(assets, { uploadErrorAfterAccept = false, existing = false, published = false } = {}) {
  let release = existing ? {
    tag_name: tag, name: tag, body: "Fixed release publishing.\n",
    prerelease: true, draft: !published, assets: [],
  } : undefined;
  const calls = [];
  let failedOnce = false;
  function gh(args) {
    calls.push(args);
    if (args[0] === "api") {
      if (!args.includes("--jq") || args.includes("--slurp")) {
        throw new Error("Release lookup must filter each page before stdout is buffered");
      }
      return release ? `${JSON.stringify(release)}\n` : "";
    }
    if (args[1] === "create") {
      release = { tag_name: tag, name: tag, body: "Fixed release publishing.\n", prerelease: true, draft: true, assets: [] };
      return "";
    }
    if (args[1] === "upload") {
      const asset = assets.find((item) => item.name === basename(args[3]));
      release.assets.push({ name: asset.name, digest: asset.digest, size: asset.size, state: "uploaded" });
      if (uploadErrorAfterAccept && !failedOnce) {
        failedOnce = true;
        throw new Error("HTTP 422: ReleaseAsset.name already exists");
      }
      return "";
    }
    if (args[1] === "edit") { release.draft = false; return ""; }
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  }
  return { gh, calls, getRelease: () => release };
}

describe("desktop release publication", () => {
  test("filters paginated release history before buffering the response", async () => {
    const input = fixture();
    const assets = await collectAssets(tag, input.macDir, input.windowsDir);
    const remote = fakeGh(assets, { existing: true, published: true });
    remote.getRelease().assets.push(...assets.map(({ name, digest, size }) => ({ name, digest, size, state: "uploaded" })));
    await publishRelease({ ...input, gh: remote.gh });
    expect(remote.calls).toEqual([["api", "--paginate", "repos/pwrdrvr/PwrGit/releases?per_page=100",
      "--jq", '.[] | select(.tag_name == "v0.18.0")']]);
  });

  test("rejects duplicate basenames before creating a release", async () => {
    const input = fixture();
    writeFileSync(join(input.windowsDir, "PwrGit.dmg"), "duplicate");
    const gh = () => { throw new Error("remote mutation must not run"); };
    await expect(publishRelease({ ...input, gh })).rejects.toThrow("Duplicate release asset basename: PwrGit.dmg");
  });

  test("rejects a missing signed asset before creating a release", async () => {
    const input = fixture();
    rmSync(join(input.macDir, "PwrGit-0.18.0-arm64.dmg"));
    await expect(publishRelease({ ...input, gh: () => { throw new Error("remote mutation must not run"); } }))
      .rejects.toThrow("Release inventory mismatch");
  });

  test("reconciles a 422 after GitHub accepted an upload, then verifies and publishes", async () => {
    const input = fixture();
    const assets = await collectAssets(tag, input.macDir, input.windowsDir);
    const remote = fakeGh(assets, { uploadErrorAfterAccept: true });
    await publishRelease({ ...input, gh: remote.gh });
    expect(remote.getRelease().draft).toBe(false);
    expect(remote.getRelease().assets).toHaveLength(14);
    expect(remote.calls.filter((args) => args[1] === "upload")).toHaveLength(14);
    expect(remote.calls.filter((args) => args[1] === "edit")).toHaveLength(1);
  });

  test("resumes a draft and refuses an asset whose digest differs", async () => {
    const input = fixture();
    const assets = await collectAssets(tag, input.macDir, input.windowsDir);
    const remote = fakeGh(assets, { existing: true });
    remote.getRelease().assets.push({ name: assets[0].name, size: assets[0].size, digest: "sha256:wrong", state: "uploaded" });
    await expect(publishRelease({ ...input, gh: remote.gh })).rejects.toThrow("differs from signed input");
    expect(remote.calls.some((args) => args[1] === "upload" || args[1] === "edit")).toBe(false);
  });

  test("resumes a matching draft without replacing verified assets", async () => {
    const input = fixture();
    const assets = await collectAssets(tag, input.macDir, input.windowsDir);
    const remote = fakeGh(assets, { existing: true });
    remote.getRelease().assets.push({ ...assets[0], state: "uploaded" });
    await publishRelease({ ...input, gh: remote.gh });
    expect(remote.calls.filter((args) => args[1] === "create")).toHaveLength(0);
    expect(remote.calls.filter((args) => args[1] === "upload")).toHaveLength(13);
    expect(remote.getRelease().assets).toHaveLength(14);
    expect(remote.getRelease().draft).toBe(false);
  });

  test("rejects a published release with missing assets", async () => {
    const input = fixture();
    const assets = await collectAssets(tag, input.macDir, input.windowsDir);
    const remote = fakeGh(assets, { existing: true, published: true });
    await expect(publishRelease({ ...input, gh: remote.gh })).rejects.toThrow("Release is missing assets");
    expect(remote.calls.some((args) => args[1] === "upload" || args[1] === "edit")).toBe(false);
  });
});
