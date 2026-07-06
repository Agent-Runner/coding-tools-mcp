export interface MenuWindow {
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * Centered-clamped window over a list: keeps `selected` visible, centers it
 * when possible, and pins to the edges near the ends so wrap-around moves
 * stay stable. Pure so it can be unit tested.
 */
export function menuWindow(total: number, selected: number, maxVisible: number): MenuWindow {
  if (total <= 0 || maxVisible <= 0) return { start: 0, end: 0 };
  const visible = Math.min(total, maxVisible);
  const clamped = Math.min(Math.max(selected, 0), total - 1);
  const start = Math.min(Math.max(clamped - Math.floor((visible - 1) / 2), 0), total - visible);
  return { start, end: start + visible };
}
