import { describe, expect, it } from "vitest";
import { featuresFor, type FeatureFlags } from "./features";

describe("featuresFor", () => {
  it.each<[Parameters<typeof featuresFor>[0], FeatureFlags]>([
    ["cloudflare", { passwordLogin: true, realtimeSync: true, feedbackForms: true }],
    ["local", { passwordLogin: false, realtimeSync: false, feedbackForms: false }],
  ])("maps %s mode to its flags", (mode, expected) => {
    expect(featuresFor(mode)).toEqual(expected);
  });
});
