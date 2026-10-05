import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LINUX_FORMATS, linuxArtifactName, writeLinuxReleaseArtifacts } from "./linux-release-artifacts.mjs";

export function verifyLinuxElf(path, arch) {
  const bytes = readFileSync(path);
  const machine = arch === "x64" ? 62 : arch === "arm64" ? 183 : undefined;
  if (bytes.length < 20 || bytes.toString("hex", 0, 4) !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== machine) {
    throw new Error(`Expected a ${arch} ELF64 little-endian binary: ${path}`);
  }
}

export function packageLinux({ stageDir, desktopRoot, builderCli, runChecked, arch = process.arch }) {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(arch) || arch !== process.arch) {
    throw new Error("Linux packaging must run on a Linux host matching the target architecture.");
  }
  const version = JSON.parse(readFileSync(join(stageDir, "package.json"), "utf8")).version;
  const dist = join(stageDir, "dist");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  // FpmTarget writes package-type into the shared app tree. A fresh build per
  // format also ensures the tar archive cannot inherit a native package marker.
  for (const format of LINUX_FORMATS) {
    const targetDir = join(stageDir, `linux-package-${format.replace(".", "-")}`);
    rmSync(targetDir, { recursive: true, force: true });
    runChecked("node", [builderCli, "--linux", format, `--${arch}`, "--publish=never", `--config.directories.output=${targetDir}`], { cwd: stageDir });
    const builtApp = join(targetDir, arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`);
    const resources = join(builtApp, "resources");
    if (format === "tar.gz") {
      if (existsSync(join(resources, "package-type"))) throw new Error("Portable archive inherited a native package marker");
    } else {
      if (readFileSync(join(resources, "package-type"), "utf8").trim() !== format) throw new Error(`Wrong ${format} updater backend marker`);
      const config = readFileSync(join(resources, "app-update.yml"), "utf8");
      if (!config.includes("repo: PwrGit") || !config.includes("owner: pwrdrvr")) throw new Error("Wrong Linux updater provider");
    }
    const gitCore = join(resources, "git", "libexec", "git-core");
    if (readdirSync(gitCore).some(name => name.startsWith("git-credential-manager") || name.endsWith(".dll") || name.endsWith(".so"))) {
      throw new Error("Unused Git Credential Manager runtime leaked into Linux package");
    }
    for (const path of [
      join(builtApp, "pwrgit"),
      join(resources, "git", "bin", "git"),
      join(resources, "git", "libexec", "git-core", "git-lfs"),
      join(resources, "app.asar.unpacked", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node")
    ]) verifyLinuxElf(path, arch);
    runChecked("node", [join(desktopRoot, "scripts", "verify-asar-contents.mjs"), builtApp], { env: { PWRGIT_ASAR_MODULE_ROOT: stageDir } });
    runChecked("node", [join(desktopRoot, "scripts", "verify-embedded-git-notices.mjs"), builtApp], { env: { PWRGIT_NOTICE_SOURCE_ROOT: stageDir } });
    const asset = linuxArtifactName(version, arch, format);
    copyFileSync(join(targetDir, asset), join(dist, asset));
  }
  writeLinuxReleaseArtifacts(dist, version, arch);
  console.log(`Linux ${arch} packages and updater metadata verified: ${dist}`);
}
