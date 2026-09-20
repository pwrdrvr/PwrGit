import { useEffect, useState } from "react";
import type { Res } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { SettingsField, SettingsSection } from "./SettingsLayout";

type Status = Res<"git:runtimeStatus">;

export function GitRuntimeDetails({ status }: { status: Status }) {
  return <div className="settings-fields selectable" style={{ overflowWrap: "anywhere" }}>
    <SettingsField label="Bundled Git" help={status.path}
      control={<span>{status.bundled.git ?? "Unavailable"}</span>} />
    <SettingsField label="Bundled Git LFS"
      control={<span>{status.bundled.lfs ?? "Unavailable"}</span>} />
    <SettingsField label="Installed Git" sub="Discovered on the CLI search path; not used by PwrGit."
      control={<span>{status.installed.git ?? "Not found"}</span>} />
    <SettingsField label="Installed Git LFS" sub="Discovered on the CLI search path; not used by PwrGit."
      control={<span>{status.installed.lfs ?? "Not found"}</span>} />
  </div>;
}

export function GitRuntimeSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void dispatch("git:runtimeStatus", undefined).then((result) => {
      if (disposed) return;
      if (result.ok) setStatus(result.value);
      else setError(result.error.message);
    }).catch(() => { if (!disposed) setError("Could not inspect Git versions."); });
    return () => { disposed = true; };
  }, []);
  return <SettingsSection eyebrow="Git" title="Git runtime" sectionId="git-runtime"
    description="PwrGit uses its bundled Git and Git LFS by default for repository operations. Installed versions are shown for reference."
    chip="Bundled · In use · Default" chipKind="default">
    <div role="status">{status ? <GitRuntimeDetails status={status} /> : error ?? "Checking Git versions…"}</div>
  </SettingsSection>;
}
