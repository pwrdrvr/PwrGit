import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import afterPack from "./afterpack-macos-uuid.mjs";
import { personalizeMacExecutableFile, personalizeMacExecutableUuid as patch } from "./macos-executable-uuid.mjs";

const identity = "com.pwrdrvr.pwrgit/0.20.0/41.10.7";
const temporary = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "pwrgit-uuid-"));
  temporary.push(dir);
  return dir;
}
function thin(cpu = 0x100000c, subtype = 0) {
  const binary = Buffer.alloc(96);
  [0xfeedfacf, cpu, subtype, 2, 2, 32].forEach((value, i) => binary.writeUInt32LE(value, i * 4));
  binary.writeUInt32LE(0x1b, 32);
  binary.writeUInt32LE(24, 36);
  binary.fill(0xab, 40, 56);
  binary.writeUInt32LE(0x1e, 56); // unrelated load command
  binary.writeUInt32LE(8, 60);
  return binary;
}
function fat(wide = false) {
  const binary = Buffer.alloc(512);
  binary.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0);
  binary.writeUInt32BE(2, 4);
  [0x100000c, 0x1000007].forEach((cpu, i) => {
    const entry = 8 + i * (wide ? 32 : 20);
    const offset = 128 + i * 128;
    binary.writeUInt32BE(cpu, entry);
    if (wide) {
      binary.writeBigUInt64BE(BigInt(offset), entry + 8);
      binary.writeBigUInt64BE(96n, entry + 16);
    } else {
      binary.writeUInt32BE(offset, entry + 8);
      binary.writeUInt32BE(96, entry + 12);
    }
    thin(cpu).copy(binary, offset);
  });
  return binary;
}
const uuid = (binary) => binary.subarray(40, 56).toString("hex");
function context(appOutDir) {
  return {
    appOutDir, electronPlatformName: "darwin",
    packager: { appInfo: { id: "com.pwrdrvr.pwrgit", version: "0.20.0", productFilename: "PwrGit" }, info: { framework: { version: "41.10.7" } } },
  };
}

describe("macOS main executable UUID", () => {
  it.each([0x100000c, 0x1000007])("changes only LC_UUID, without mutating input, for CPU %s", (cpu) => {
    const original = thin(cpu);
    const updated = patch(original, identity);
    expect(uuid(updated)).not.toBe(uuid(original));
    expect(updated.subarray(0, 40)).toEqual(original.subarray(0, 40));
    expect(updated.subarray(56)).toEqual(original.subarray(56));
    expect(patch(updated, identity)).toEqual(updated);
    expect(original).toEqual(thin(cpu));
    expect(updated[46] >> 4).toBe(8);
    expect(updated[48] >> 6).toBe(2);
  });
  it("separates products, releases, Electron versions and CPU subtypes", () => {
    const values = [
      patch(thin(), identity),
      patch(thin(), "com.pwrdrvr.pwragent/0.20.0/41.10.7"),
      patch(thin(), "com.pwrdrvr.pwrgit/0.21.0/41.10.7"),
      patch(thin(), "com.pwrdrvr.pwrgit/0.20.0/42.0.0"),
      patch(thin(0x1000007), identity),
      patch(thin(0x100000c, 2), identity),
    ];
    expect(new Set(values.map(uuid)).size).toBe(values.length);
  });
  it.each([false, true])("handles universal binaries and repeated merge passes (fat64=%s)", (wide) => {
    const original = fat(wide);
    const updated = patch(original, identity);
    const expected = Buffer.from(original);
    patch(thin(), identity).copy(expected, 128);
    patch(thin(0x1000007), identity).copy(expected, 256);
    expect(updated).toEqual(expected);
    expect(patch(updated, identity)).toEqual(updated);
  });
  it("rejects malformed inputs without changing their bytes", () => {
    const cases = [Buffer.alloc(0), thin().subarray(0, 50)];
    for (const [offset, value] of [[0, 0xfeedface], [12, 6], [16, 1], [20, 0xffffffff], [32, 0x19], [36, 0], [36, 25], [56, 0x1b]]) {
      const binary = thin(); binary.writeUInt32LE(value, offset); cases.push(binary);
    }
    for (const [offset, value] of [[4, 0], [4, 0xffffffff], [16, 8], [36, 128], [20, 0xffffffff], [8, 7]]) {
      const binary = fat(); binary.writeUInt32BE(value, offset); cases.push(binary);
    }
    const unsafe = fat(true); unsafe.writeBigUInt64BE(2n ** 60n, 16); cases.push(unsafe);
    for (const binary of cases) {
      const before = Buffer.from(binary);
      expect(() => patch(binary, identity)).toThrow();
      expect(binary).toEqual(before);
    }
    expect(() => patch(thin(), "")).toThrow();
  });
  it("patches only the staged main executable and preserves mode and repeat-call mtime", async () => {
    const dir = await temp();
    const contents = join(dir, "PwrGit.app", "Contents");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await mkdir(join(contents, "Frameworks"));
    const file = join(contents, "MacOS", "PwrGit");
    const framework = join(contents, "Frameworks", "Electron Framework");
    await writeFile(file, fat(), { mode: 0o755 });
    await writeFile(framework, thin());
    await writeFile(join(contents, "Info.plist"), "bundle identity stays unchanged");
    // Windows does not expose POSIX executable bits; assert preservation of
    // the mode the filesystem actually assigned rather than the requested 0755.
    const originalMode = (await stat(file)).mode;
    await afterPack(context(dir));
    expect(await readFile(file)).toEqual(patch(fat(), identity));
    const before = await stat(file);
    await afterPack(context(dir));
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect((await stat(file)).mode).toBe(originalMode);
    expect(await readFile(framework)).toEqual(thin());
    expect(await readFile(join(contents, "Info.plist"), "utf8")).toBe("bundle identity stays unchanged");
  });
  it("skips non-macOS and fails on missing identity, missing file or corrupt input", async () => {
    await afterPack({ electronPlatformName: "win32" });
    await afterPack({ electronPlatformName: "linux" });
    const dir = await temp();
    const bad = context(dir); bad.packager.appInfo.id = "";
    await expect(afterPack(bad)).rejects.toThrow(/identity/);
    await expect(afterPack(context(dir))).rejects.toThrow(/ENOENT/);
    const file = join(dir, "bad");
    await writeFile(file, "not Mach-O");
    await expect(personalizeMacExecutableFile(file, identity)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("not Mach-O");
  });
  it.skipIf(process.platform !== "darwin")("survives lipo and re-signing, with UUIDs recognized by Apple tools", async () => {
    const dir = await temp();
    const source = join(dir, "main.c");
    await writeFile(source, "int main(void) { return 0; }\n");
    const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const slices = [];
    for (const arch of ["arm64", "x86_64"]) {
      const file = join(dir, arch);
      run("xcrun", ["clang", "-arch", arch, source, "-o", file]);
      await personalizeMacExecutableFile(file, identity);
      slices.push(file);
    }
    const universal = join(dir, "universal");
    run("lipo", ["-create", ...slices, "-output", universal]);
    const before = await readFile(universal);
    await personalizeMacExecutableFile(universal, identity);
    expect(await readFile(universal)).toEqual(before);
    const uuids = run("dwarfdump", ["--uuid", universal]);
    expect(uuids).toContain("(arm64)");
    expect(uuids).toContain("(x86_64)");
    run("codesign", ["--force", "--sign", "-", universal]);
    run("codesign", ["--verify", "--strict", "--all-architectures", universal]);
    await personalizeMacExecutableFile(universal, `${identity}-changed`);
    expect(() => run("codesign", ["--verify", "--strict", "--all-architectures", universal])).toThrow();
    await personalizeMacExecutableFile(universal, identity);
    run("codesign", ["--force", "--sign", "-", universal]);
    run("codesign", ["--verify", "--strict", "--all-architectures", universal]);
    expect(run("dwarfdump", ["--uuid", universal])).toBe(uuids);
  });
});
