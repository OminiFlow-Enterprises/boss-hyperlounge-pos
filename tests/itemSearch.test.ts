import { describe, expect, it } from "vitest";
import { itemMatchScore } from "../src/shared/itemSearch.js";

describe("item search", () => {
  it("finds Kingfisher Ultra when the typed letters skip one character", () => {
    expect(itemMatchScore("KINGFISHER ULTRA PINT", "BAR-KUP", "utra")).not.toBeNull();
    expect(itemMatchScore("KINGFISHER ULTRA BUCKET", "BAR-KUB", "utra")).not.toBeNull();
    expect(itemMatchScore("MOCHA", "M1", "utra")).toBeNull();
  });

  it("still prefers the name that starts with what was typed", () => {
    const ultra = itemMatchScore("KINGFISHER ULTRA", "KF01", "king");
    const other = itemMatchScore("KINGFISHER STRONG", "KF02", "king");
    expect(ultra).toBe(0);
    expect(other).toBe(0);
  });
});