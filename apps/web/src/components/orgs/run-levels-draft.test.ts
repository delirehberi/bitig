import { describe, expect, it } from "vitest";
import { RUN_LEVEL_KEY_PATTERN } from "@bitig/core";
import { draftsFromServer, levelKeyFromLabel, removedKeys, toSaveInput, validateDrafts } from "./run-levels-draft";

const OPUS = { providerInstanceId: "prov-claude", model: "claude-opus" };
const GPT = { providerInstanceId: "prov-codex", model: "gpt-6" };

describe("run levels draft (#BIT-188)", () => {
  it("derives a valid, unused key from a label", () => {
    expect(levelKeyFromLabel("Very Strong!", new Set())).toBe("very-strong");
    expect(levelKeyFromLabel("Cheap", new Set(["cheap", "cheap-2"]))).toBe("cheap-3");
    expect(levelKeyFromLabel("  ***  ", new Set())).toBe("level");
    const long = levelKeyFromLabel("a".repeat(80), new Set(["a".repeat(64)]));
    expect(long).toMatch(RUN_LEVEL_KEY_PATTERN);
    expect(long.length).toBeLessThanOrEqual(64);
  });

  it("splits default and per-host models, ordered by level order", () => {
    const drafts = draftsFromServer(
      [
        { key: "strong", label: "Strong", description: "Hard", order: 1 },
        { key: "cheap", label: "Cheap", description: "Easy", order: 0 },
      ],
      [
        { levelKey: "strong", hostId: null, selection: OPUS },
        { levelKey: "strong", hostId: "host-b", selection: GPT },
      ],
    );
    expect(drafts.map((d) => d.key)).toEqual(["cheap", "strong"]);
    expect(drafts[1]?.selection).toEqual(OPUS);
    expect(drafts[1]?.hostOverrides).toEqual({ "host-b": GPT });
    expect(drafts[0]?.selection).toBeNull();
  });

  it("builds the full save body with keys for new rows, row order and replacements", () => {
    const { input, keys } = toSaveInput(
      [
        { rowId: "new:1", key: undefined, label: "Strong", description: " New ", selection: GPT, hostOverrides: {} },
        { rowId: "saved:strong", key: "strong", label: "Deep", description: "Hard", selection: OPUS, hostOverrides: { h: GPT } },
      ],
      { cheap: "strong" },
    );
    expect(keys).toEqual(["strong-2", "strong"]);
    expect(input).toEqual({
      levels: [
        { key: "strong-2", label: "Strong", description: "New", order: 0 },
        { key: "strong", label: "Deep", description: "Hard", order: 1 },
      ],
      models: [
        { levelKey: "strong-2", hostId: null, selection: GPT },
        { levelKey: "strong", hostId: null, selection: OPUS },
        { levelKey: "strong", hostId: "h", selection: GPT },
      ],
      replacementKeys: { cheap: "strong" },
    });
  });

  it("reports removed keys and blocks saves without a name or description", () => {
    const row = { rowId: "saved:a", key: "a", label: "A", description: "d", selection: null, hostOverrides: {} };
    expect(removedKeys(["a", "b"], [row])).toEqual(["b"]);
    expect(validateDrafts([])).toMatch(/at least one/i);
    expect(validateDrafts([{ ...row, label: " " }])).toMatch(/needs a name/i);
    expect(validateDrafts([{ ...row, description: "" }])).toMatch(/router reads it/i);
    expect(validateDrafts([row])).toBeUndefined();
  });
});
