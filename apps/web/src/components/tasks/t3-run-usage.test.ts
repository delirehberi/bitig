import { describe, expect, it } from "vitest";
import { formatRunElapsed } from "./t3-run-usage";

describe("formatRunElapsed (#BIT-163)", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatRunElapsed(0)).toBe("0s");
    expect(formatRunElapsed(45_000)).toBe("45s");
    expect(formatRunElapsed(125_500)).toBe("2m 06s");
    expect(formatRunElapsed(3_720_000)).toBe("1h 02m");
  });
});
