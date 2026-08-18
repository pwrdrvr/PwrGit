import { describe, expect, it } from "vitest";
import { imageMediaType } from "./image";

describe("imageMediaType", () => {
  it("maps the formats a browser renders, case-insensitively", () => {
    expect(imageMediaType("art/logo.png")).toBe("image/png");
    expect(imageMediaType("art/anim.GIF")).toBe("image/gif");
    expect(imageMediaType("art/photo.JPEG")).toBe("image/jpeg");
    expect(imageMediaType("art/hero.webp")).toBe("image/webp");
    expect(imageMediaType("art/next.avif")).toBe("image/avif");
    expect(imageMediaType("art/mark.svg")).toBe("image/svg+xml");
  });

  it("rejects paths that are not images", () => {
    expect(imageMediaType("src/app.ts")).toBeNull();
    expect(imageMediaType("LICENSE")).toBeNull();
    expect(imageMediaType("dist/bundle.png.gz")).toBeNull();
  });

  it("ignores an extension that belongs to a directory, not the file", () => {
    expect(imageMediaType("art.png/README")).toBeNull();
    expect(imageMediaType("art.png/icon.webp")).toBe("image/webp");
  });

  it("treats a dotfile as extensionless", () => {
    expect(imageMediaType(".png")).toBeNull();
  });
});
