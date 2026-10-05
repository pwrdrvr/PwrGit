import electronUpdater from "electron-updater";
import type { AppManualUpdateInstructions } from "@pwrgit/shared";

export type LinuxPackageFormat = "deb" | "rpm" | "pacman";

// The pinned updater reads resources/package-type and constructs this backend.
// AppImage is deliberately excluded: PwrGit does not package its runtime.
export function linuxPackageFormat(): LinuxPackageFormat | undefined {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) return undefined;
  const updater = electronUpdater.autoUpdater;
  if (updater instanceof electronUpdater.DebUpdater) return "deb";
  if (updater instanceof electronUpdater.RpmUpdater) return "rpm";
  if (updater instanceof electronUpdater.PacmanUpdater) return "pacman";
  return undefined;
}

export function linuxArtifactSuffix(format: LinuxPackageFormat, arch = process.arch): string {
  const packageArch = arch === "x64"
    ? (format === "deb" ? "amd64" : format === "rpm" ? "x86_64" : "x64")
    : (format === "rpm" || format === "pacman" ? "aarch64" : arch);
  return `-linux-${packageArch}.${format}`;
}

export function linuxChannelFile(arch = process.arch): string {
  return arch === "x64" ? "latest-linux.yml" : `latest-linux-${arch}.yml`;
}

export function linuxManualUpdateInstructions(tag?: string): AppManualUpdateInstructions | undefined {
  if (process.platform !== "linux") return undefined;
  const format = linuxPackageFormat();
  if (!format) return {
    description: "This portable or unsupported Linux build cannot update itself. Open https://github.com/pwrdrvr/PwrGit/releases, download a tar.gz for your architecture, close PwrGit, and replace the extracted directory. DEB, RPM, and pacman installations support in-app updates."
  };
  // Accept only our release-tag shape before placing it in a shell command.
  const selectedTag = tag && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) ? tag : undefined;
  const filename = `PwrGit-linux-${process.arch}.${format}`;
  const source = selectedTag
    ? `download/${selectedTag}/PwrGit-${selectedTag.slice(1)}${linuxArtifactSuffix(format)}`
    : `latest/download/${filename}`;
  const install = format === "deb" ? "apt install" : format === "rpm" ? "rpm -Uvh --oldpackage" : "pacman -U";
  return {
    description: `Close PwrGit and run this command in a terminal to install ${selectedTag ?? "the latest stable release"}. Installation requires administrator authorization.`,
    command: `curl -fL -o "${filename}" "https://github.com/pwrdrvr/PwrGit/releases/${source}" && sudo ${install} "./${filename}"`
  };
}
