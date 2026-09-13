// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { FORGE_KINDS, type ForgeKind } from "@pwrgit/shared";
import { resetBrandThemeForTests } from "../../lib/brandTheme";
import { ForgeMark } from "./ForgeMark";

async function draw(kind: ForgeKind, size?: number) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ForgeMark kind={kind} {...(size === undefined ? {} : { size })} />));
  return {
    img: container.querySelector("img")!,
    rerender: async () => act(async () => root.render(<ForgeMark kind={kind} />)),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    }
  };
}

function lightTheme(on: boolean): void {
  if (on) document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
}

afterEach(() => {
  lightTheme(false);
  resetBrandThemeForTests();
});

it("draws a mark for every forge, so adding a product cannot ship a blank chip", async () => {
  for (const kind of FORGE_KINDS) {
    const { img, cleanup } = await draw(kind);
    expect(img.getAttribute("src"), kind).toBeTruthy();
    await cleanup();
  }
});

it("draws a different file per forge", async () => {
  const seen = new Set<string>();
  for (const kind of FORGE_KINDS) {
    const { img, cleanup } = await draw(kind);
    seen.add(img.getAttribute("src") ?? "");
    await cleanup();
  }
  expect(seen.size).toBe(FORGE_KINDS.length);
});

it("swaps to GitHub's own black variant on the light theme, rather than recoloring one", async () => {
  lightTheme(false);
  const dark = await draw("github");
  const darkSrc = dark.img.getAttribute("src");
  await dark.cleanup();

  lightTheme(true);
  const light = await draw("github");
  expect(light.img.getAttribute("src")).not.toBe(darkSrc);
  await light.cleanup();
});

it("follows a theme flip that happens while it is mounted", async () => {
  const { img, cleanup } = await draw("github");
  const before = img.getAttribute("src");
  await act(async () => {
    lightTheme(true);
  });
  expect(img.getAttribute("src")).not.toBe(before);
  await cleanup();
});

it("keeps the tanuki's single published colorway on both themes", async () => {
  lightTheme(false);
  const dark = await draw("gitlab");
  const darkSrc = dark.img.getAttribute("src");
  await dark.cleanup();

  lightTheme(true);
  const light = await draw("gitlab");
  expect(light.img.getAttribute("src")).toBe(darkSrc);
  await light.cleanup();
});

it("fits the mark in a square box instead of stretching a non-square artboard", async () => {
  // Both artboards are ~2% off square. Without `contain` the vendors' "no
  // warping" rule is broken by the width/height pair alone.
  const { img, cleanup } = await draw("github", 12);
  expect(img.getAttribute("width")).toBe("12");
  expect(img.getAttribute("height")).toBe("12");
  expect(img.style.objectFit).toBe("contain");
  await cleanup();
});

it("never asks CSS to repaint the mark", async () => {
  for (const kind of FORGE_KINDS) {
    const { img, cleanup } = await draw(kind);
    expect(img.style.filter, kind).toBe("");
    expect(img.style.fill, kind).toBe("");
    expect(img.getAttribute("class"), kind).toBeNull();
    await cleanup();
  }
});

/**
 * The rule these files exist to keep: PwrGit ships the vendors' bytes. An edit
 * to the artwork — a recolor, a re-trace, a "just tidy the path" — is the one
 * change the brand guidance forbids, and it would otherwise be invisible in a
 * diff full of legitimate churn.
 */
it("ships each vendor's file unaltered", () => {
  const assets = [
    ["../../assets/github/invertocat-black.svg", "black"],
    ["../../assets/github/invertocat-white.svg", "white"],
    ["../../assets/gitlab/tanuki.svg", null],
    ["../../assets/gitcafe/favicon.svg", null]
  ] as const;
  for (const [rel, fill] of assets) {
    const svg = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(svg.startsWith("<svg"), rel).toBe(true);
    // No `currentColor` anywhere: these are painted by the vendor, not by us.
    expect(svg.includes("currentColor"), rel).toBe(false);
    if (fill !== null) expect(svg.includes(`fill="${fill}"`), rel).toBe(true);
  }
});
