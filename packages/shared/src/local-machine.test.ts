import { describe, expect, it } from "vitest";
import { localMachineNoun } from "./local-machine";

describe("localMachineNoun", () => {
  it("names the machine the way each platform does", () => {
    expect(localMachineNoun("darwin")).toBe("Mac");
    expect(localMachineNoun("win32")).toBe("PC");
    expect(localMachineNoun("linux")).toBe("computer");
    expect(localMachineNoun(undefined)).toBe("computer");
  });
});
