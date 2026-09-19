import { describe, expect, it } from "vitest";
import type { AcpAgentInstance } from "@pwrgit/shared";
import { resolveActiveAcpInstance } from "./acp-instance-resolver";

const pathFirst: AcpAgentInstance = { command: "/usr/local/bin/grok", source: "path", version: "1.0.0" };
const pathSecond: AcpAgentInstance = { command: "/opt/grok/bin/grok", source: "path", version: "1.2.0" };
const fallback: AcpAgentInstance = { command: "/home/me/.local/bin/grok", source: "fallback" };
const override: AcpAgentInstance = { command: "/custom/grok", source: "override" };

describe("resolveActiveAcpInstance", () => {
  it("runs the first discovered install when nothing is chosen", () => {
    expect(resolveActiveAcpInstance([pathFirst, pathSecond], undefined)).toBe(pathFirst);
    expect(resolveActiveAcpInstance([pathFirst, pathSecond], {})).toBe(pathFirst);
  });

  it("runs a pinned install while it is still among the installs", () => {
    expect(
      resolveActiveAcpInstance([pathFirst, pathSecond, fallback], {
        selectedPath: pathSecond.command
      })
    ).toBe(pathSecond);
  });

  it("matches a pinned path with stray whitespace around it", () => {
    expect(
      resolveActiveAcpInstance([pathFirst, pathSecond], {
        selectedPath: `  ${pathSecond.command}\n`
      })
    ).toBe(pathSecond);
  });

  it("falls back to the first install when the pinned one has gone", () => {
    // Uninstalled since it was pinned: the badge must name something that
    // will actually run, not the stale choice.
    expect(
      resolveActiveAcpInstance([pathFirst, pathSecond], { selectedPath: "/gone/grok" })
    ).toBe(pathFirst);
  });

  it("treats a blank pinned path as no pin", () => {
    expect(resolveActiveAcpInstance([pathFirst, pathSecond], { selectedPath: "   " })).toBe(
      pathFirst
    );
  });

  it("lets an installed override win over a pin, wherever discovery listed it", () => {
    expect(
      resolveActiveAcpInstance([pathFirst, pathSecond, override], {
        selectedPath: pathSecond.command,
        overridePath: override.command
      })
    ).toBe(override);
  });

  it("does not honor an override path that did not pass the probe", () => {
    // Discovery only tags an install "override" when the override path was
    // probed and passed; a preference alone never makes a binary run.
    expect(
      resolveActiveAcpInstance([pathFirst, pathSecond], {
        overridePath: "/custom/grok",
        selectedPath: pathSecond.command
      })
    ).toBe(pathSecond);
  });
});
