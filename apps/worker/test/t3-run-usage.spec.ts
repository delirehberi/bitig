import { describe, expect, it } from "vitest";
import { readRunUsageReadout } from "../src/t3/client";

const STARTED_AT = "2026-01-01T00:00:00.000Z";
const COMPLETED_AT = "2026-01-01T00:02:05.500Z";
const ELAPSED_MS = 125_500;

describe("readRunUsageReadout (#BIT-163)", () => {
  it("returns undefined when there is no run or the run has not completed", () => {
    expect(readRunUsageReadout(undefined)).toBeUndefined();
    expect(readRunUsageReadout({ status: "running", startedAt: STARTED_AT })).toBeUndefined();
    expect(readRunUsageReadout({ status: "running", startedAt: STARTED_AT, completedAt: "" })).toBeUndefined();
  });

  it("derives elapsed milliseconds from T3 start and completion timestamps", () => {
    expect(readRunUsageReadout({ status: "completed", startedAt: STARTED_AT, completedAt: COMPLETED_AT })).toEqual({
      elapsedMs: ELAPSED_MS,
    });
  });

  it("omits elapsed time when the start timestamp is missing, unparseable, or after completion", () => {
    expect(readRunUsageReadout({ status: "completed", completedAt: COMPLETED_AT })).toBeUndefined();
    expect(readRunUsageReadout({ status: "completed", startedAt: COMPLETED_AT, completedAt: STARTED_AT })).toBeUndefined();
    expect(readRunUsageReadout({ status: "completed", startedAt: "not-a-date", completedAt: COMPLETED_AT })).toBeUndefined();
  });
});
