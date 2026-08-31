import { describe, expect, it } from "vitest";
import { fileStatusChipProps } from "./fileStatus";

/** Exercised through the one export, since that is all a call site can reach. */
const tone = (status: string): string =>
  fileStatusChipProps(status).className.replace("file-status file-status--", "");
const label = (status: string): string => fileStatusChipProps(status).title;

describe("fileStatus", () => {
  it("maps the codes the rail and history both render", () => {
    expect(tone("M")).toBe("warn");
    expect(tone("A")).toBe("ok");
    expect(tone("D")).toBe("danger");
    expect(tone("U")).toBe("danger");
    expect(tone("?")).toBe("muted");
  });

  it("falls back rather than rendering an unnamed chip", () => {
    expect(tone("Z")).toBe("muted");
    expect(label("Z")).toBe("Changed");
    expect(label("")).toBe("Changed");
  });

  it("always carries an accessible name alongside the class", () => {
    expect(fileStatusChipProps("R")).toEqual({
      className: "file-status file-status--warn",
      title: "Renamed",
      "aria-label": "Renamed"
    });
  });
});
