import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ForgeKind } from "@pwrgit/shared";
import type {
  E2EForgeFixtureFile,
  E2EForgeHostFixture
} from "../../src/main/forge/e2e-forge-fixture";
import type { GitSandbox } from "./git-sandbox";

export type ForgeFixtureCall = {
  host: ForgeKind;
  operation: string;
  input: Record<string, unknown>;
};

export type ForgeFixtureHandle = {
  path: string;
  config: E2EForgeFixtureFile;
  write: () => void;
  calls: () => ForgeFixtureCall[];
};

/** A mutable file-backed provider fixture. Main rereads it at every provider
 *  call, so a Playwright test can clear an auth/outage response and exercise
 *  a real in-dialog retry without relaunching the app. */
export function createForgeFixture(
  sandbox: GitSandbox,
  hosts: Partial<Record<ForgeKind, E2EForgeHostFixture>>
): ForgeFixtureHandle {
  const base = dirname(sandbox.reposDir);
  const path = join(base, "forge-fixture.json");
  const callsPath = join(base, "forge-calls.jsonl");
  const config: E2EForgeFixtureFile = { callsPath, hosts };
  const write = (): void => {
    writeFileSync(path, JSON.stringify(config, null, 2));
  };
  write();
  return {
    path,
    config,
    write,
    calls: () => {
      if (!existsSync(callsPath)) return [];
      return readFileSync(callsPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ForgeFixtureCall);
    }
  };
}
