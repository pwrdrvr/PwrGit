import { describe, expect, it } from "vitest";
import type { Profile } from "@pwrgit/shared";
import { profileWindowTitle } from "./profileTitle";

const p = (id: string, name: string, email: string): Profile => ({
  id,
  name,
  email,
  mono: "",
  roots: []
});

describe("profileWindowTitle", () => {
  it("uses the plain profile name when it's unique", () => {
    const profiles = [p("a", "PwrDrvr", "h@pwrdrvr.com"), p("b", "Acme", "h@acme.dev")];
    expect(profileWindowTitle(profiles, profiles[0] ?? null)).toBe(
      "PwrGit — PwrDrvr"
    );
  });

  it("appends the email when two profiles share a name", () => {
    const profiles = [
      p("a", "Harold Hunt", "harold@pwrdrvr.com"),
      p("b", "Harold Hunt", "hhunt@acme.dev")
    ];
    expect(profileWindowTitle(profiles, profiles[0] ?? null)).toBe(
      "PwrGit — Harold Hunt (harold@pwrdrvr.com)"
    );
    expect(profileWindowTitle(profiles, profiles[1] ?? null)).toBe(
      "PwrGit — Harold Hunt (hhunt@acme.dev)"
    );
  });

  it("falls back to the bare app name without a profile", () => {
    expect(profileWindowTitle([], null)).toBe("PwrGit");
  });
});
