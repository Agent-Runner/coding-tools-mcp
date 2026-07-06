import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProfileForPath } from "../src/profiles/config.js";
import { advanceOnboarding, loadOnboardingState } from "../src/tui/onboarding.js";

describe("TUI onboarding", () => {
  it("writes a direct-mode profile after accepting the two defaults", async () => {
    const home = await mkdtemp(join(tmpdir(), "ctc-onboarding-home-"));
    const repo = await mkdtemp(join(tmpdir(), "ctc-onboarding-repo-"));
    process.env.CTC_HOME = home;

    const first = await loadOnboardingState(repo);
    expect(first?.step).toBe("backend");
    if (!first) throw new Error("Expected onboarding to be required.");

    const second = await advanceOnboarding(first, "");
    expect(second.step).toBe("permissions");

    const complete = await advanceOnboarding(second, "");
    expect(complete.complete).toBe(true);

    const profile = await readProfileForPath(repo);
    expect(profile?.backend.type).toBe("stdio");
    expect(profile?.defaultMode).toBe("direct");
    expect(profile?.permissionMode).toBe("safe");
    await expect(loadOnboardingState(repo)).resolves.toBeUndefined();
  });
});
