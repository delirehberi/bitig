import { describe, expect, it } from "vitest";
import { row, samplePlan, WQ_CAPABILITIES, WQ_PROJECTS } from "./work-queue-fixtures";
import {
  addCodes,
  buildOverrides,
  describeLaneWaves,
  describeRowStatus,
  effortValues,
  findCapability,
  planWarnings,
  queuedCodes,
  replaceCode,
  replacePromptKey,
  unknownKeyMessage,
} from "./work-queue-model";

describe("replacePromptKey", () => {
  it("swaps an unknown key in codes and keeps the rest of the text", () => {
    expect(replacePromptKey("Start BIT-92, kom-03 and #KOM 4", "KOM", "KMZ")).toBe("Start BIT-92, KMZ-03 and KMZ 4");
  });

  it("leaves words that only start with the key alone", () => {
    expect(replacePromptKey("komodo KOM-1", "KOM", "KMZ")).toBe("komodo KMZ-1");
  });
});

describe("unknownKeyMessage", () => {
  it("names the suggested project", () => {
    expect(unknownKeyMessage("KOM", ["KMZ"], WQ_PROJECTS)).toBe("KOM is not a project key. Did you mean KMZ (Komuz)?");
  });

  it("says only that the key is unknown without suggestions", () => {
    expect(unknownKeyMessage("ZZZ", [], WQ_PROJECTS)).toBe("ZZZ is not a project key.");
  });
});

describe("describeRowStatus", () => {
  it("explains each classification with the codes it refers to", () => {
    expect(describeRowStatus(row(1))).toBe("Ready");
    expect(describeRowStatus(row(2, { classification: "after_queued_task", related: ["BIT-1"] }))).toBe("After BIT-1");
    expect(describeRowStatus(row(3, { classification: "waits_on_unqueued_task", related: ["BIT-80"] }))).toBe(
      "Waits on BIT-80 (not queued)",
    );
    expect(describeRowStatus(row(4, { classification: "not_found" }))).toBe("BIT-4 doesn't exist");
    expect(describeRowStatus(row(5, { classification: "project_not_connected" }))).toBe(
      "BIT is not connected to a T3 project",
    );
    expect(describeRowStatus(row(6, { classification: "needs_person", related: ["Which DB?"] }))).toBe(
      "Waiting on you: Which DB?",
    );
    expect(describeRowStatus(row(7, { classification: "unlisted_parent", related: ["BIT-183"] }))).toBe(
      "Part of BIT-183",
    );
  });
});

describe("code list edits", () => {
  it("replaces a code without duplicating one already listed", () => {
    expect(replaceCode(["BIT-1", "BIT-2", "BIT-183"], "BIT-2", "BIT-183")).toEqual(["BIT-1", "BIT-183"]);
  });

  it("appends only new codes", () => {
    expect(addCodes(["BIT-1"], ["BIT-1", "BIT-80"])).toEqual(["BIT-1", "BIT-80"]);
  });
});

describe("queuedCodes", () => {
  it("counts queueable rows and ticked pending rows", () => {
    expect(queuedCodes(samplePlan(), new Set(["BIT-95"]))).toEqual(["BIT-92", "BIT-93", "BIT-94", "BIT-95"]);
  });
});

describe("describeLaneWaves", () => {
  it("lists waves and why a task waits", () => {
    const plan = samplePlan();
    const lane = plan.lanes[0];
    if (!lane) throw new Error("fixture has a lane");
    expect(describeLaneWaves(lane, plan.rows)).toBe("Wave 1: BIT-92, BIT-93 · Wave 2: BIT-94 after BIT-92");
  });

  it("carries a parallel skip reason into the later wave", () => {
    const plan = samplePlan([row(1), row(2)]);
    const lane = {
      ...plan.lanes[0],
      projectId: "p",
      projectKey: "BIT",
      projectName: "Bitig",
      needsQueueUmbrella: true,
      codes: ["BIT-1", "BIT-2"],
      waves: [
        {
          number: 1,
          codes: ["BIT-1"],
          skipped: [{ code: "BIT-2", reason: "overlaps_picked" as const, message: "touches overlap BIT-1" }],
        },
        { number: 2, codes: ["BIT-2"], skipped: [] },
      ],
    };
    expect(describeLaneWaves(lane, plan.rows)).toBe("Wave 1: BIT-1 · Wave 2: BIT-2 (touches overlap BIT-1)");
  });
});

describe("buildOverrides", () => {
  it("sends only edited rows that will be queued", () => {
    const drafts = new Map([
      ["BIT-92", { level: "strong" }],
      ["BIT-93", {}],
      ["BIT-97", { effort: "high" }],
    ]);
    expect(buildOverrides(drafts, ["BIT-92", "BIT-93"])).toEqual([{ code: "BIT-92", level: "strong" }]);
  });
});

describe("effort options", () => {
  it("reads effort values from the model's capability", () => {
    const cap = findCapability(WQ_CAPABILITIES, "claudeAgent", "claude-opus-5-5");
    expect(effortValues(cap)).toEqual(["low", "medium", "high"]);
    expect(effortValues(findCapability(WQ_CAPABILITIES, null, null))).toEqual([]);
  });
});

describe("planWarnings", () => {
  it("adds unparsed words and router failures to the parser warnings", () => {
    const plan = samplePlan();
    const warnings = planWarnings({
      ...plan,
      parse: { ...plan.parse, unparsed: ["header"] },
      routing: { enabled: true, attempted: 2, failed: 1 },
    });
    expect(warnings).toEqual([
      "AI parse fallback skipped (router disabled); showing the deterministic result.",
      "Not understood: header",
      "The AI router could not suggest a level for 1 task; the default level applies.",
    ]);
  });
});
