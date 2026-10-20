import { describe, expect, it } from "vitest";
import { featuresFor, type FeatureFlags } from "./features";

describe("featuresFor", () => {
  it.each<[Parameters<typeof featuresFor>[0], FeatureFlags]>([
    ["cloudflare", { taskVisibility: false, passwordLogin: true, realtimeSync: true }],
    ["nostr", { taskVisibility: true, passwordLogin: false, realtimeSync: false }],
    ["local", { taskVisibility: false, passwordLogin: false, realtimeSync: false }],
  ])("maps %s mode to its flags", (mode, expected) => {
    expect(featuresFor(mode)).toEqual(expected);
  });
});
