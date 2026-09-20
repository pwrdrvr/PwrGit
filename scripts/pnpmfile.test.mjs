import { describe, expect, it } from "vitest";
import pnpmfile from "../.pnpmfile.cjs";

const { readPackage } = pnpmfile.hooks;

// `isGitSpec` isn't exported, so drive the hook pnpm actually calls.
// `dependencies` is the field with no carve-out: a git spec there
// throws, anything else passes through untouched.
function classify(spec) {
  const pkg = { name: "some-registry-package", dependencies: { dep: spec } };
  try {
    readPackage(pkg);
    return "allowed";
  } catch {
    return "blocked";
  }
}

describe("pnpmfile git-dependency guard", () => {
  // The allow side. Nothing covered this, which is exactly why the
  // `user/repo` shortcut branch was silently eating local-protocol
  // specs whose path is a single segment — `file:../local` parsed as
  // `file:..` + `/` + `local`. Two-segment specs escaped by accident,
  // so test both lengths or the regression hides again.
  it.each([
    "file:../local",
    "link:../local",
    "workspace:../pkg",
    "file:./packages/x",
    "link:../../tools/thing",
    "workspace:*",
    "workspace:^",
    "^1.2.3",
    "1.2.3",
    "~4.0.0",
    "npm:other-pkg@1.0.0",
    "catalog:",
    "*"
  ])("allows the non-git spec %s", (spec) => {
    expect(classify(spec)).toBe("allowed");
  });

  // The block side — the whole point of the file. Every shape pnpm
  // recognizes as a git fetch must still throw.
  it.each([
    "github:user/repo",
    "user/repo",
    "user/repo#v1.0.0",
    "git+https://github.com/user/repo.git",
    "git+ssh://git@github.com/user/repo.git",
    "git://github.com/user/repo.git",
    "git@github.com:user/repo.git",
    "ssh://git@github.com/user/repo.git",
    "gitlab:x/y",
    "bitbucket:x/y",
    "https://github.com/user/repo",
    "http://www.gitlab.com/user/repo",
    "git+file:///srv/repo.git"
  ])("blocks the git spec %s", (spec) => {
    expect(classify(spec)).toBe("blocked");
  });

  it("names the offending dependency in the error", () => {
    expect(() =>
      readPackage({ name: "pwrgit-workspace", dependencies: { evil: "github:a/b" } })
    ).toThrow(/Blocked git dependency evil@github:a\/b/);
  });

  // The carve-out documented in .pnpmfile.cjs: a transitive package's
  // devDependencies are never installed, so a git spec there is
  // stripped rather than thrown. Our own packages are still scanned.
  it("strips a git devDependency from a transitive package", () => {
    const pkg = { name: "buffer-crc32", devDependencies: { tap: "github:iansu/eslint-plugin-node-core" } };
    expect(readPackage(pkg).devDependencies).toEqual({});
  });

  it.each(["pwrgit-workspace", "@pwrgit/desktop"])(
    "throws on a git devDependency in %s",
    (name) => {
      expect(() => readPackage({ name, devDependencies: { evil: "user/repo" } })).toThrow(
        /Blocked git dependency/
      );
    }
  );

  it("leaves a non-git devDependency in place for any package", () => {
    const pkg = { name: "buffer-crc32", devDependencies: { tap: "^16.0.0", local: "file:../local" } };
    expect(readPackage(pkg).devDependencies).toEqual({ tap: "^16.0.0", local: "file:../local" });
  });
});
