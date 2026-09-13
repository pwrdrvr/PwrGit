// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ForgeChip } from "./ForgeChip";

async function draw(chip: Parameters<typeof ForgeChip>[0]["chip"]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ForgeChip chip={chip} />));
  return {
    el: container.querySelector<HTMLElement>(".forge-chip")!,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    }
  };
}

it("draws the product's mark and no words when the mark answers alone", async () => {
  const { el, cleanup } = await draw({
    kind: "github",
    name: null,
    others: 0,
    title: "origin is on github.com"
  });
  expect(el.querySelector("img")).not.toBeNull();
  expect(el.textContent).toBe("");
  // The words it dropped are still reachable — the chip is an abbreviation,
  // not a loss.
  expect(el.title).toBe("origin is on github.com");
  expect(el.className).toContain("forge-chip--mark");
  await cleanup();
});

it("draws a different mark per product", async () => {
  const gh = await draw({ kind: "github", name: null, others: 0, title: "a" });
  const ghSrc = gh.el.querySelector("img")?.getAttribute("src");
  await gh.cleanup();
  const gl = await draw({ kind: "gitlab", name: null, others: 0, title: "b" });
  const glSrc = gl.el.querySelector("img")?.getAttribute("src");
  await gl.cleanup();
  expect(ghSrc).toBeTruthy();
  expect(glSrc).toBeTruthy();
  expect(ghSrc).not.toBe(glSrc);
});

it("adds the name beside the mark when the mark is ambiguous", async () => {
  const { el, cleanup } = await draw({
    kind: "github",
    name: "acme",
    others: 0,
    title: "origin is on ghe.acme.example"
  });
  expect(el.querySelector("img")).not.toBeNull();
  expect(el.querySelector(".forge-chip__name")?.textContent).toBe("acme");
  expect(el.className).not.toContain("forge-chip--mark");
  await cleanup();
});

it("keeps the count in its own node, where an ellipsis cannot eat it", async () => {
  // The name is the half that truncates; the `+n` is what says the chip is
  // not the whole answer, so it must not be part of the same text run.
  const { el, cleanup } = await draw({
    kind: "gitlab",
    name: "acme",
    others: 2,
    title: "origin is on gitlab.acme.example; also GitHub, GitLab"
  });
  expect(el.querySelector(".forge-chip__name")?.textContent).toBe("acme");
  expect(el.querySelector(".forge-chip__more")?.textContent).toBe("+2");
  await cleanup();
});

it("counts even with no name to hang the count off", async () => {
  const { el, cleanup } = await draw({
    kind: "gitlab",
    name: null,
    others: 1,
    title: "origin is on gitlab.com; also GitHub"
  });
  expect(el.querySelector(".forge-chip__name")).toBeNull();
  expect(el.querySelector(".forge-chip__more")?.textContent).toBe("+1");
  await cleanup();
});

it("falls back to words for a host with no mark", async () => {
  const { el, cleanup } = await draw({
    kind: null,
    name: "acme",
    others: 0,
    title: "origin is on git.acme.test"
  });
  expect(el.querySelector("img")).toBeNull();
  expect(el.querySelector(".forge-chip__name")?.textContent).toBe("acme");
  await cleanup();
});

it("is hidden from assistive tech, which reads the row's description instead", async () => {
  const { el, cleanup } = await draw({
    kind: "github",
    name: null,
    others: 0,
    title: "origin is on github.com"
  });
  expect(el.getAttribute("aria-hidden")).toBe("true");
  await cleanup();
});

it("draws the bare mark at the size of the glyphs it sits beside", async () => {
  // 12px is what `RepoIdentityMarks` draws the lock, globe and fork at, one
  // element away. A bare mark that missed it would read as a logo dropped into
  // a row of icons rather than as one of them.
  const { el, cleanup } = await draw({
    kind: "github",
    name: null,
    others: 0,
    title: "origin is on github.com"
  });
  expect(el.querySelector("img")?.getAttribute("width")).toBe("12");
  await cleanup();
});

it("draws a smaller mark inside a pill, which has a border to clear", async () => {
  // The pill caps out at 16px — as tall as a chip on a repo row can be without
  // driving the row's height — so 14px is all there is between its borders.
  const { el, cleanup } = await draw({
    kind: "github",
    name: "acme",
    others: 0,
    title: "origin is on ghe.acme.example"
  });
  expect(el.querySelector("img")?.getAttribute("width")).toBe("11");
  await cleanup();
});
