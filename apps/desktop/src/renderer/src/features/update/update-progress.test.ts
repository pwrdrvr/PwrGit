import { describe, expect, it } from "vitest";
import {
  downloadMeter,
  isUpdateCheckInProgress,
  updateProgressCopy
} from "./update-progress";

describe("isUpdateCheckInProgress", () => {
  it("covers every status a check passes through before it has an answer", () => {
    expect(isUpdateCheckInProgress({ status: "checking" })).toBe(true);
    expect(
      isUpdateCheckInProgress({ status: "available", version: "1.0.0" })
    ).toBe(true);
    expect(
      isUpdateCheckInProgress({ status: "downloading", version: "1.0.0" })
    ).toBe(true);
  });

  it("excludes every settled one, so the live card comes down", () => {
    for (const status of [
      { status: "idle" },
      { status: "no-update", version: "1.0.0" },
      { status: "downloaded", version: "1.0.0" },
      { status: "canceled", version: "1.0.0" },
      { status: "skipped", reason: "not here" },
      { status: "error", message: "nope" }
    ] as const) {
      expect(isUpdateCheckInProgress(status)).toBe(false);
    }
  });
});

describe("updateProgressCopy", () => {
  it("sweeps while the release read is out, with nothing to cancel yet", () => {
    const copy = updateProgressCopy({ status: "checking" });

    expect(copy.title).toBe("Checking for updates");
    expect(copy.percent).toBeUndefined();
    expect(copy.cancelable).toBe(false);
    // Nothing to read about either: `checking` has no version yet, and that is
    // the one card that deliberately renders no release-notes link.
    expect(copy.notesUrl).toBeUndefined();
  });

  it("carries the release page for every phase that names a version", () => {
    expect(
      updateProgressCopy({ status: "available", version: "1.0.0" }).notesUrl
    ).toBe("https://github.com/pwrdrvr/PwrGit/releases/tag/v1.0.0");
    expect(
      updateProgressCopy({ status: "downloading", version: "1.0.0", percent: 42 })
        .notesUrl
    ).toBe("https://github.com/pwrdrvr/PwrGit/releases/tag/v1.0.0");
  });

  it("offers Cancel as soon as a download is the thing being waited on", () => {
    expect(
      updateProgressCopy({ status: "available", version: "1.0.0" }).cancelable
    ).toBe(true);
  });

  it("names the version and the percent it is at", () => {
    const copy = updateProgressCopy({
      status: "downloading",
      version: "1.0.0",
      percent: 42,
      transferred: 50_000_000,
      total: 118_000_000,
      bytesPerSecond: 3_300_000
    });

    expect(copy.message).toBe("PwrGit v1.0.0 — 42%");
    expect(copy.percent).toBe(42);
    expect(copy.meter).toBe("47.7 MB of 112.5 MB · 3.1 MB/s");
    expect(copy.cancelable).toBe(true);
  });

  it("falls back to the sweep when the feed reports no percent", () => {
    // A provider that sends no content length leaves electron-updater nothing
    // to compute one from; a bar pinned at 0 would read as a stalled download.
    const copy = updateProgressCopy({ status: "downloading", version: "1.0.0" });

    expect(copy.message).toBe("PwrGit v1.0.0");
    expect(copy.percent).toBeUndefined();
    expect(copy.meter).toBeUndefined();
  });

  it("clamps a percent the feed overshot rather than overflowing the bar", () => {
    expect(
      updateProgressCopy({
        status: "downloading",
        version: "1.0.0",
        percent: 104
      }).percent
    ).toBe(100);
  });
});

describe("downloadMeter", () => {
  it("drops the half it does not know", () => {
    expect(downloadMeter({ transferred: 2_048 })).toBe("2.0 KB transferred");
    expect(downloadMeter({ bytesPerSecond: 500 })).toBe("500 B/s");
    expect(downloadMeter({})).toBeUndefined();
  });

  it("does not divide by a total the feed reported as zero", () => {
    expect(downloadMeter({ transferred: 1_024, total: 0 })).toBe(
      "1.0 KB transferred"
    );
  });

  it("ignores a rate of zero rather than printing a stalled one", () => {
    // electron-updater reports 0 B/s on the first tick, before it has two
    // samples to divide.
    expect(downloadMeter({ transferred: 0, total: 1_024, bytesPerSecond: 0 })).toBe(
      "0 B of 1.0 KB"
    );
  });
});
