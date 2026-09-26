import { join } from "node:path";
import { personalizeMacExecutableFile } from "./macos-executable-uuid.mjs";

// Runs for each thin app and again after the universal merge, before signing.
export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const { appInfo, info } = context.packager;
  const { id, version, productFilename } = appInfo;
  const electronVersion = info.framework.version;
  if ([id, version, productFilename, electronVersion].some((value) => typeof value !== "string" || !value)) {
    throw new Error("Missing macOS executable UUID packaging identity");
  }
  const executable = join(context.appOutDir, `${productFilename}.app`, "Contents", "MacOS", productFilename);
  await personalizeMacExecutableFile(executable, `${id}/${version}/${electronVersion}`);
}
