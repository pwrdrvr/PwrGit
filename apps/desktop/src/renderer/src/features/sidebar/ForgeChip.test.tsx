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

it("carries the full hostname in its title, so the short name loses nothing", async () => {
  const { el, cleanup } = await draw({
    name: "acme",
    others: 0,
    title: "origin is on github.acme.huge-corp.southeast.us.corp"
  });
  expect(el.title).toBe("origin is on github.acme.huge-corp.southeast.us.corp");
  expect(el.textContent).toBe("acme");
  await cleanup();
});

it("keeps the count in its own node, where an ellipsis cannot eat it", async () => {
  // The name is the half that truncates; the `+n` is what says the name is
  // not the whole answer, so it must not be part of the same text run.
  const { el, cleanup } = await draw({
    name: "GitLab",
    others: 2,
    title: "origin is on gitlab.com; also GitHub, Acme"
  });
  expect(el.querySelector(".forge-chip__name")?.textContent).toBe("GitLab");
  expect(el.querySelector(".forge-chip__more")?.textContent).toBe("+2");
  await cleanup();
});

it("is hidden from assistive tech, which reads the row's description instead", async () => {
  const { el, cleanup } = await draw({
    name: "GitHub",
    others: 0,
    title: "origin is on github.com"
  });
  expect(el.getAttribute("aria-hidden")).toBe("true");
  await cleanup();
});
