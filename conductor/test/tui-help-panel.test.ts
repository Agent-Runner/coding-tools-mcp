import { describe, expect, it } from "vitest";
import { helpLines } from "../src/tui/components/Panels.js";
import { slashCommands } from "../src/tui/commands/registry.js";

describe("helpLines", () => {
  it("lists every command grouped, with no Planned section", () => {
    const lines = helpLines();
    const texts = lines.map((line) => line.text);
    expect(texts).not.toContain("Planned");

    const headers = texts.filter((text) => ["Sessions", "Review", "Configure", "Interface", "Keys"].includes(text));
    expect(headers).toEqual(["Sessions", "Review", "Configure", "Interface", "Keys"]);

    const body = texts.join("\n");
    for (const command of slashCommands) {
      const occurrences = texts.filter((text) => text.includes(`${command.usage} `) || text.trimEnd().endsWith(command.usage)).length;
      expect(occurrences, command.usage).toBeGreaterThanOrEqual(1);
    }
    expect(body).toContain("cancel pickers");
  });
});
