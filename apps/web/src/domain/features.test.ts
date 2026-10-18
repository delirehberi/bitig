import { describe, expect, it } from "vitest";
import { featuresFor, type FeatureFlags } from "./features";

describe("featuresFor", () => {
  it.each<[Parameters<typeof featuresFor>[0], FeatureFlags]>([
    ["cloudflare", { taskVisibility: false, basicAuthLogin: true }],
    ["nostr", { taskVisibility: true, basicAuthLogin: false }],
    ["local", { taskVisibility: false, basicAuthLogin: false }],
  ])("maps %s mode to its flags", (mode, expected) => {
    expect(featuresFor(mode)).toEqual(expected);
  });
});
