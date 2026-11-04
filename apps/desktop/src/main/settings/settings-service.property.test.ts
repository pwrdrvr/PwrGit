import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { SettingsService, type AppSettings } from "./settings-service";

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", () => ({
  mkdirSync: () => undefined,
  readFileSync: (path: string) => {
    if (!disk.has(path)) throw new Error("missing settings file");
    return disk.get(path);
  },
  writeFileSync: (path: string, value: string) => { disk.set(path, value); },
  renameSync: (from: string, to: string) => {
    disk.set(to, disk.get(from)!);
    disk.delete(from);
  }
}));

type Model = { source: boolean; seed: boolean };
type Real = { service: SettingsService };
const path = "/fixture/settings.json";

function agrees(model: Model, real: Real): void {
  const settings = real.service.get();
  const actual = {
    source: settings.worktreeReflink === "on",
    seed: settings.worktreeSeedCargoTarget === "on"
  };
  // User promise: Cargo seeding never survives disabling source sharing,
  // including after a restart and after source sharing is enabled again.
  expect(actual.seed && !actual.source).toBe(false);
  expect(actual).toEqual(model);
}

class Configure implements fc.Command<Model, Real> {
  constructor(private readonly patch: Pick<AppSettings, "worktreeReflink" | "worktreeSeedCargoTarget">) {}
  check(): boolean { return true; }
  run(model: Model, real: Real): void {
    if (this.patch.worktreeReflink !== undefined) model.source = this.patch.worktreeReflink === "on";
    if (this.patch.worktreeSeedCargoTarget !== undefined) model.seed = this.patch.worktreeSeedCargoTarget === "on";
    if (!model.source) model.seed = false;
    real.service.update(this.patch);
    agrees(model, real);
  }
  toString(): string { return `configure(${JSON.stringify(this.patch)})`; }
}

class Restart implements fc.Command<Model, Real> {
  check(): boolean { return true; }
  run(model: Model, real: Real): void {
    real.service = new SettingsService(path);
    agrees(model, real);
  }
  toString(): string { return "restart"; }
}

describe("worktree sharing settings model", () => {
  it("preserves the seeding prerequisite through arbitrary changes and restarts", () => {
    const toggle = fc.constantFrom("off", "on");
    const commands = fc.commands([
      toggle.map((value) => new Configure({ worktreeReflink: value })),
      toggle.map((value) => new Configure({ worktreeSeedCargoTarget: value })),
      fc.tuple(toggle, toggle).map(([source, seed]) => new Configure({ worktreeReflink: source, worktreeSeedCargoTarget: seed })),
      fc.constant(new Restart())
    ], { maxCommands: 30 });
    fc.assert(fc.property(commands, (sequence) => {
      disk.clear();
      fc.modelRun(() => ({
        model: { source: false, seed: false },
        real: { service: new SettingsService(path) }
      }), sequence);
    }));
  });
});
