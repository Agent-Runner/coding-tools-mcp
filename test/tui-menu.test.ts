import { describe, expect, it } from "vitest";
import { menuWindow } from "../src/tui/menu.js";

describe("menuWindow", () => {
  it("shows everything when the list fits", () => {
    expect(menuWindow(5, 0, 10)).toEqual({ start: 0, end: 5 });
    expect(menuWindow(10, 9, 10)).toEqual({ start: 0, end: 10 });
    expect(menuWindow(1, 0, 4)).toEqual({ start: 0, end: 1 });
  });

  it("keeps the selection visible across the whole range", () => {
    for (let selected = 0; selected < 16; selected += 1) {
      const { start, end } = menuWindow(16, selected, 10);
      expect(end - start).toBe(10);
      expect(start).toBeLessThanOrEqual(selected);
      expect(selected).toBeLessThan(end);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(16);
    }
  });

  it("pins to the edges and centers in the middle", () => {
    expect(menuWindow(16, 0, 10)).toEqual({ start: 0, end: 10 });
    expect(menuWindow(16, 15, 10)).toEqual({ start: 6, end: 16 });
    expect(menuWindow(16, 8, 10)).toEqual({ start: 4, end: 14 });
  });

  it("tolerates degenerate inputs without throwing", () => {
    expect(menuWindow(0, 0, 10)).toEqual({ start: 0, end: 0 });
    expect(menuWindow(5, 0, 0)).toEqual({ start: 0, end: 0 });
    expect(menuWindow(5, -3, 2)).toEqual({ start: 0, end: 2 });
    expect(menuWindow(5, 99, 2)).toEqual({ start: 3, end: 5 });
  });
});
