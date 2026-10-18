import { describe, expect, it } from "vitest";
import { STORAGE_MODES, isStorageMode } from "./index";

describe("isStorageMode", () => {
  it.each(STORAGE_MODES)("accepts %s", (mode) => {
    expect(isStorageMode(mode)).toBe(true);
  });

  it.each([undefined, null, "", "LOCAL", "d1", 1, {}])("rejects %o", (value) => {
    expect(isStorageMode(value)).toBe(false);
  });
});

