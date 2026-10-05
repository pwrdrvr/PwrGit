import { useState } from "react";
import type { AppManualUpdateInstructions } from "@pwrgit/shared";

export function ManualUpdateInstructions({ instructions }: { instructions: AppManualUpdateInstructions | undefined }) {
  const [copiedCommand, setCopiedCommand] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  if (!instructions) return null;
  return (
    <div className="manual-update-instructions selectable">
      <p>{instructions.description}</p>
      {instructions.command && <>
        <pre>{instructions.command}</pre>
        <button className="settings-button" type="button" onClick={() => {
          const command = instructions.command;
          if (!command) return;
          setCopyError(undefined);
          void navigator.clipboard.writeText(command).then(
            () => setCopiedCommand(command),
            (error: unknown) => setCopyError(error instanceof Error ? error.message : String(error))
          );
        }}>{copiedCommand === instructions.command ? "Copied" : "Copy update command"}</button>
        {copyError && <p role="alert">{copyError}</p>}
      </>}
    </div>
  );
}
