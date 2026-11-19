import { describe, expect, it } from "vitest";
import { itemMatchScore } from "../src/shared/itemSearch.js";

describe("item search", () => {
  const name = "KINGFISHER ULTRA STRONG";

  it("finds the item by the full name or by the first, second, or third word", () => {
    expect(itemMatchScore(name, "KF", "kingfisher ultra strong")).toBe(0);
    expect(itemMatchScore(name, "KF", "kingfisher")).toBe(0);
    expect(itemMatchScore(name, "KF", "ultra")).toBe(1);
    expect(itemMatchScore(name, "KF", "strong")).toBe(1);
    expect(itemMatchScore(name, "KF", "ultra strong")).toBe(1);
    expect(itemMatchScore(name, "KF", "king ultra")).toBe(0);
    expect(itemMatchScore(name, "KF", "king strong")).toBe(2);
  });

  it("typing ultra lists only names that contain that word in sequence", () => {
    expect(itemMatchScore("KINGFISHER ULTRA PINT", "BAR-KUP", "ultra")).not.toBeNull();
    expect(itemMatchScore("KINGFISHER ULTRA BUCKET", "BAR-KUB", "ultra")).not.toBeNull();
    expect(itemMatchScore("KINGFISHER PREMIUM PINT", "BAR-KPP", "ultra")).toBeNull();
    expect(itemMatchScore("MOCHA", "M1", "ultra")).toBeNull();
    expect(itemMatchScore("MUSHROOM STROGANOFF WITH HERBED RICE", "F1", "strong")).toBeNull();
    expect(itemMatchScore("KINGFISHER ULTRA PINT", "BAR-KUP", "utra")).toBeNull();
  });

  it("keeps typed words in order", () => {
    expect(itemMatchScore("KINGFISHER ULTRA PINT", "BAR-KUP", "ultra pint")).toBe(1);
    expect(itemMatchScore("KINGFISHER ULTRA PINT", "BAR-KUP", "pint ultra")).toBeNull();
    expect(itemMatchScore("11 KINGFISHER ULTRA PINT", "892", "king ultra")).toBe(1);
  });

  it("still prefers the name that starts with what was typed", () => {
    const ultra = itemMatchScore("KINGFISHER ULTRA", "KF01", "king");
    const other = itemMatchScore("KINGFISHER STRONG", "KF02", "king");
    expect(ultra).toBe(0);
    expect(other).toBe(0);
    expect(itemMatchScore("X KINGFISHER STRONG", "KF03", "king")).toBe(1);
  });

  it("still finds an item by a later code word", () => {
    expect(itemMatchScore("KINGFISHER ULTRA PINT", "BAR-KUP", "kup")).toBe(1);
  });
});
