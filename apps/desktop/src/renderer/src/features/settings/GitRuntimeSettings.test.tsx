import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { GitRuntimeDetails, GitRuntimeSettings } from "./GitRuntimeSettings";

it("labels the bundled runtime as in use and the default", () => {
  const html = renderToStaticMarkup(<GitRuntimeSettings />);
  expect(html).toContain("Bundled · In use · Default");
  expect(html).toContain("Checking Git versions");
});

it("keeps bundled and installed versions distinct, including missing LFS", () => {
  const html = renderToStaticMarkup(<GitRuntimeDetails status={{
    active: "bundled", default: "bundled", path: "/fixture/git/bin/git",
    bundled: { git: "git version 2.50.fixture", lfs: "git-lfs/3.6.fixture" },
    installed: { git: "git version 2.40.fixture", lfs: null }
  }} />);
  for (const text of ["Bundled Git", "Bundled Git LFS", "Installed Git", "Installed Git LFS", "2.50.fixture", "3.6.fixture", "2.40.fixture", "Not found", "not used by PwrGit"])
    expect(html).toContain(text);
});
