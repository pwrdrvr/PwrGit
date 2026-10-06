import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { expect, test } from "vitest";
import { generateLinuxIcons, LINUX_ICON_SIZES } from "./generate-linux-icons.mjs";
import { verifyLinuxDesktopIcons } from "./verify-linux-packages.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electronBuilderRequire = createRequire(require.resolve("electron-builder"));
const builderRequire = createRequire(electronBuilderRequire.resolve("app-builder-lib"));
const config = builderRequire("js-yaml").load(readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8"));
// Load the public entrypoint first so the builder's circular packager imports initialize.
builderRequire("./index");
const { LinuxTargetHelper } = builderRequire("./targets/LinuxTargetHelper");
const { PlatformPackager } = builderRequire("./platformPackager");

function iconHelper(icon, output) {
  const packager = {
    config: { ...config, directories: { output } },
    platformSpecificBuildOptions: { ...config.linux, icon },
    projectDir: desktopRoot,
    buildResourcesDir: join(desktopRoot, "build"),
    expandMacro: value => value,
    getDefaultFrameworkIcon: () => null
  };
  packager.resolveIcon = PlatformPackager.prototype.resolveIcon.bind(packager);
  return new LinuxTargetHelper(packager);
}

test("the pinned packager selects the standard Linux sizes instead of the old 1024px-only icon", async () => {
  const output = mkdtempSync(join(tmpdir(), "pwrgit-icon-builder-"));
  try {
    const oldIcons = await iconHelper("build/icon.png", output).icons;
    expect(oldIcons.map(icon => icon.size)).toEqual([1024]);
    const icons = await iconHelper(config.linux.icon, output).icons;
    expect(icons.map(icon => icon.size)).toEqual(LINUX_ICON_SIZES);
    for (const icon of icons) {
      const image = await sharp(icon.file).metadata();
      expect([image.width, image.height]).toEqual([icon.size, icon.size]);
    }
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test("checked-in Linux icons reproduce from the full-bleed master", async () => {
  const build = mkdtempSync(join(tmpdir(), "pwrgit-icon-generator-"));
  try {
    copyFileSync(join(desktopRoot, "build", "icon.png"), join(build, "icon.png"));
    await generateLinuxIcons(build);
    for (const size of LINUX_ICON_SIZES) {
      const generated = await sharp(join(build, "icons", `${size}x${size}.png`)).ensureAlpha().raw().toBuffer();
      const committed = await sharp(join(desktopRoot, "build", "icons", `${size}x${size}.png`)).ensureAlpha().raw().toBuffer();
      expect(generated.length).toBe(committed.length);
      // Allow one rounding level across native SIMD implementations; compare
      // decoded artwork rather than platform-specific PNG compression bytes.
      let difference = 0;
      for (let index = 0; index < generated.length; index += 1) {
        difference = Math.max(difference, Math.abs(generated[index] - committed[index]));
      }
      expect(difference).toBeLessThanOrEqual(1);
    }
  } finally { rmSync(build, { recursive: true, force: true }); }
});

test("native package validation rejects an unresolved or mis-sized launcher icon", () => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-icon-payload-"));
  const iconPath = size => join(root, "usr", "share", "icons", "hicolor", `${size}x${size}`, "apps", "pwrgit.png");
  try {
    // Reproduce the published DEB's sole 1024x1024 icon directory.
    mkdirSync(dirname(iconPath(1024)), { recursive: true });
    copyFileSync(join(desktopRoot, "build", "icon.png"), iconPath(1024));
    expect(() => verifyLinuxDesktopIcons(root, "Icon=pwrgit\n")).toThrow("ENOENT");
    for (const size of LINUX_ICON_SIZES) {
      mkdirSync(dirname(iconPath(size)), { recursive: true });
      copyFileSync(join(desktopRoot, "build", "icons", `${size}x${size}.png`), iconPath(size));
    }
    verifyLinuxDesktopIcons(root, "Icon=pwrgit\n");
    expect(() => verifyLinuxDesktopIcons(root, "Icon=wrong-name\n")).toThrow();
    copyFileSync(iconPath(32), iconPath(16));
    expect(() => verifyLinuxDesktopIcons(root, "Icon=pwrgit\n")).toThrow("Launcher icon width");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
