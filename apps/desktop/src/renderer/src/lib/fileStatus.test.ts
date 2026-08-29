import { describe, expect, it } from "vitest";
import {
  fileStatusChipProps,
  fileStatusLabel,
  fileStatusTone
} from "./fileStatus";

describe("fileStatus", () => {
  it("maps the codes the rail and history both render", () => {
    expect(fileStatusTone("M")).toBe("warn");
    expect(fileStatusTone("A")).toBe("ok");
    expect(fileStatusTone("D")).toBe("danger");
    expect(fileStatusTone("U")).toBe("danger");
    expect(fileStatusTone("?")).toBe("muted");
  });

  it("falls back rather than rendering an unnamed chip", () => {
    expect(fileStatusTone("Z")).toBe("muted");
    expect(fileStatusLabel("Z")).toBe("Changed");
    expect(fileStatusLabel("")).toBe("Changed");
  });

  it("always carries an accessible name alongside the class", () => {
    expect(fileStatusChipProps("R")).toEqual({
      className: "file-status file-status--warn",
      title: "Renamed",
      "aria-label": "Renamed"
    });
  });
});
