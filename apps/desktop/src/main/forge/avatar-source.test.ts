import { afterEach, describe, expect, it } from "vitest";
import {
  clearRememberedForgeAvatarHosts,
  normalizeForgeAvatarSourceUrl,
  rememberForgeAvatarHost
} from "./avatar-source";

afterEach(() => {
  clearRememberedForgeAvatarHosts();
});

describe("normalizeForgeAvatarSourceUrl", () => {
  it("keeps GitHub's output byte-identical to before the generalization", () => {
    expect(
      normalizeForgeAvatarSourceUrl("https://avatars.githubusercontent.com/u/1?v=4")
    ).toBe("https://avatars.githubusercontent.com/u/1?v=4&s=64");
  });

  it("preserves Gravatar's fallback-image parameter", () => {
    // Without `d`, an account with no Gravatar renders as a blank square
    // instead of its identicon.
    expect(
      normalizeForgeAvatarSourceUrl(
        "https://secure.gravatar.com/avatar/abc?s=80&d=identicon"
      )
    ).toBe("https://secure.gravatar.com/avatar/abc?d=identicon&s=64");
  });

  it("accepts an upload on the SaaS forge hosts", () => {
    expect(
      normalizeForgeAvatarSourceUrl(
        "https://gitlab.com/uploads/-/system/user/avatar/1/avatar.png"
      )
    ).toBe("https://gitlab.com/uploads/-/system/user/avatar/1/avatar.png?s=64");
  });

  it("resolves a relative avatar path against its instance", () => {
    rememberForgeAvatarHost("gitlab.example.com");
    expect(
      normalizeForgeAvatarSourceUrl(
        "/uploads/-/system/user/avatar/1/avatar.png",
        "https://gitlab.example.com"
      )
    ).toBe(
      "https://gitlab.example.com/uploads/-/system/user/avatar/1/avatar.png?s=64"
    );
  });

  it("only trusts a self-managed host once it has been seen on a real origin", () => {
    const url = "https://gitlab.corp.internal/uploads/avatar.png";
    expect(normalizeForgeAvatarSourceUrl(url)).toBeUndefined();
    rememberForgeAvatarHost("GitLab.Corp.Internal");
    expect(normalizeForgeAvatarSourceUrl(url)).toBe(
      "https://gitlab.corp.internal/uploads/avatar.png?s=64"
    );
  });

  it("refuses arbitrary hosts and plaintext transport", () => {
    expect(normalizeForgeAvatarSourceUrl("https://example.com/avatar.png")).toBeUndefined();
    expect(
      normalizeForgeAvatarSourceUrl("http://avatars.githubusercontent.com/u/1")
    ).toBeUndefined();
    expect(normalizeForgeAvatarSourceUrl("not a url")).toBeUndefined();
    expect(normalizeForgeAvatarSourceUrl("")).toBeUndefined();
  });

  it("refuses embedded credentials", () => {
    expect(
      normalizeForgeAvatarSourceUrl("https://user:pass@gitlab.com/uploads/a.png")
    ).toBeUndefined();
  });

  it("strips every unrecognized query parameter and the fragment", () => {
    // A signed or tokenized URL must never reach SQLite, the disk cache, or a
    // later image request.
    expect(
      normalizeForgeAvatarSourceUrl(
        "https://gitlab.com/uploads/a.png?X-Amz-Signature=deadbeef&token=secret&d=identicon#frag"
      )
    ).toBe("https://gitlab.com/uploads/a.png?d=identicon&s=64");
  });

  it("drops a preserved parameter whose value is not a simple token", () => {
    expect(
      normalizeForgeAvatarSourceUrl(
        "https://avatars.githubusercontent.com/u/1?v=" + "x".repeat(80)
      )
    ).toBe("https://avatars.githubusercontent.com/u/1?s=64");
    expect(
      normalizeForgeAvatarSourceUrl("https://gitlab.com/a.png?d=https://evil.test/x")
    ).toBe("https://gitlab.com/a.png?s=64");
  });

  it("always pins the requested size", () => {
    expect(
      normalizeForgeAvatarSourceUrl("https://secure.gravatar.com/avatar/abc?s=999")
    ).toBe("https://secure.gravatar.com/avatar/abc?s=64");
  });
});
