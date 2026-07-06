import { describe, expect, it } from "vitest";
import { loginShellPath, mergePathWithLoginShell, resetLoginShellPathCache } from "../src/shared/shell-env.js";

describe("mergePathWithLoginShell", () => {
  it("adopts the login shell order when the current PATH is a default subset", () => {
    // GUI-launched host: minimal PATH, every entry also known to the login shell.
    const merged = mergePathWithLoginShell("/usr/bin:/bin", "/home/u/.nvm/versions/node/v24.0.0/bin:/usr/bin:/bin");
    expect(merged).toBe("/home/u/.nvm/versions/node/v24.0.0/bin:/usr/bin:/bin");
  });

  it("keeps deliberate custom entries in front and only appends missing login entries", () => {
    const merged = mergePathWithLoginShell("/custom/bin:/usr/bin", "/home/u/.nvm/bin:/usr/bin:/bin");
    expect(merged).toBe("/custom/bin:/usr/bin:/home/u/.nvm/bin:/bin");
  });

  it("falls back to whichever side exists", () => {
    expect(mergePathWithLoginShell("/usr/bin", undefined)).toBe("/usr/bin");
    expect(mergePathWithLoginShell(undefined, "/login/bin")).toBe("/login/bin");
    expect(mergePathWithLoginShell(undefined, undefined)).toBeUndefined();
  });
});

describe("loginShellPath", () => {
  it("resolves a non-empty PATH from the login shell or degrades to undefined", async () => {
    resetLoginShellPathCache();
    const path = await loginShellPath();
    // Environment-dependent: a usable login shell answers with a PATH string;
    // anything else (missing shell, timeout, Windows) degrades to undefined.
    if (path !== undefined) {
      expect(path.length).toBeGreaterThan(0);
      expect(path).not.toContain("\n");
    }
  });

  it("honors the CTC_NO_LOGIN_SHELL_PATH opt-out", async () => {
    process.env.CTC_NO_LOGIN_SHELL_PATH = "1";
    try {
      resetLoginShellPathCache();
      await expect(loginShellPath()).resolves.toBeUndefined();
    } finally {
      delete process.env.CTC_NO_LOGIN_SHELL_PATH;
      resetLoginShellPathCache();
    }
  });
});
