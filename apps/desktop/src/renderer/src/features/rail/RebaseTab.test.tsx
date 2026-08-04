import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelectionBar } from "../graph/SelectionBar";
import { RebaseTab } from "./RebaseTab";

describe("rebase tool copy", () => {
  it("describes the deterministic tool and makes no AI involvement claims", () => {
    const panel = renderToStaticMarkup(
      <RebaseTab
        worktreeId={null}
        sourceHead={null}
        selectedHashes={[]}
        op={null}
        onClear={() => undefined}
      />
    );
    const selection = renderToStaticMarkup(
      <SelectionBar
        count={2}
        onSquash={() => undefined}
        onReorder={() => undefined}
        onOpenRebaseTool={() => undefined}
        onClear={() => undefined}
      />
    );
    const copy = `${panel} ${selection}`;

    expect(copy).toContain("Rebase tool");
    expect(copy).toContain("Isolated check · hooks and signing disabled");
    expect(copy).toContain("Open rebase tool");
    expect(copy).not.toMatch(/Codex|\bAI\b|ACP|assistant|Ask agent/i);
  });
});
