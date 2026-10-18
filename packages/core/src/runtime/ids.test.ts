import { describe, expect, it } from "vitest";
import { IdSchema } from "../domain/schemas";
import { defaultIdGenerator, systemClock, toTimestamp } from "./ids";

const SAMPLE_SIZE = 1_000;

describe("defaultIdGenerator", () => {
  it("produces valid UUIDv7 strings", () => {
    const id = defaultIdGenerator();
    expect(IdSchema.safeParse(id).success).toBe(true);
    expect(id[14]).toBe("7");
  });

  it("produces unique IDs that sort in generation order", () => {
    const ids = Array.from({ length: SAMPLE_SIZE }, () => defaultIdGenerator());
    expect(new Set(ids).size).toBe(SAMPLE_SIZE);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe("clock helpers", () => {
  it("formats timestamps as ISO 8601 UTC", () => {
    expect(toTimestamp(new Date(Date.UTC(2026, 9, 8, 12)))).toBe("2026-10-08T12:00:00.000Z");
  });

  it("systemClock returns the current time", () => {
    const before = Date.now();
    const now = systemClock().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

