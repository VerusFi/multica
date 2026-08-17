import { afterEach, describe, expect, it, vi } from "vitest";
import { selfhostNavUrl } from "./selfhost-url";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("selfhostNavUrl", () => {
  it("returns null when NEXT_PUBLIC_SELFHOST_URL is unset, so the nav link is omitted instead of pointing at a nonexistent /selfhost route", () => {
    vi.stubEnv("NEXT_PUBLIC_SELFHOST_URL", undefined);
    expect(selfhostNavUrl()).toBeNull();
  });

  it("returns null for an empty or whitespace-only value", () => {
    vi.stubEnv("NEXT_PUBLIC_SELFHOST_URL", "");
    expect(selfhostNavUrl()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SELFHOST_URL", "   ");
    expect(selfhostNavUrl()).toBeNull();
  });

  it("returns the configured URL for deployments that set one", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_SELFHOST_URL",
      " https://owner.github.io/multica/selfhost.html ",
    );
    expect(selfhostNavUrl()).toBe(
      "https://owner.github.io/multica/selfhost.html",
    );
  });
});
