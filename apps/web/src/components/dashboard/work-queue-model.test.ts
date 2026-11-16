import { describe, expect, it } from "vitest";
import type { RunLevel } from "@bitig/core";
import type { WorkQueueEntryView, WorkQueueView } from "../../services/work-queue";
import { row, samplePlan, WQ_CAPABILITIES, WQ_PROJECTS } from "./work-queue-fixtures";
import {
  addCodes,
  applyRealtimeEvent,
  canRetryEntry,
  canSkipEntry,
  laneProgress,
  nextLevelUp,
  queueControls,
  queueTitle,
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

describe("queue panel helpers", () => {
  const QUEUE = "q-1";
  const LANE = "lane-bit";
  const AT = "2026-11-16T00:00:00.000Z";
  const levels: RunLevel[] = [
    { key: "cheap", label: "Cheap", description: "", order: 0, selection: { providerInstanceId: "p", model: "small" } },
    { key: "mid", label: "Mid", description: "", order: 1, selection: { providerInstanceId: "p", model: "medium" } },
    { key: "strong", label: "Strong", description: "", order: 2, selection: { providerInstanceId: "p", model: "large" } },
  ];

  function entry(id: string, overrides: Partial<WorkQueueEntryView> = {}): WorkQueueEntryView {
    return {
      id,
      queueId: QUEUE,
      taskId: `task-${id}`,
      position: 0,
      lane: LANE,
      state: "waiting",
      waitingReason: null,
      resolvedSelection: null,
      umbrellaTaskId: null,
      createdAt: AT,
      updatedAt: AT,
      taskCode: `BIT-${id}`,
      ...overrides,
    };
  }

  function queue(overrides: Partial<WorkQueueView> = {}): WorkQueueView {
    return {
      id: QUEUE,
      orgId: "org",
      createdBy: "Emre",
      prompt: "Start BIT-1",
      state: "active",
      createdAt: AT,
      updatedAt: AT,
      entries: [entry("1")],
      ...overrides,
    };
  }

  describe("queueControls", () => {
    it("offers pause only while active, resume only while paused, cancel while still open", () => {
      expect(queueControls("active")).toEqual({ pause: true, resume: false, cancel: true });
      expect(queueControls("paused")).toEqual({ pause: false, resume: true, cancel: true });
      expect(queueControls("planning")).toEqual({ pause: false, resume: false, cancel: true });
      expect(queueControls("done")).toEqual({ pause: false, resume: false, cancel: false });
      expect(queueControls("cancelled")).toEqual({ pause: false, resume: false, cancel: false });
    });
  });

  describe("entry controls", () => {
    it("allows skip only before a task starts", () => {
      expect(canSkipEntry("waiting")).toBe(true);
      expect(canSkipEntry("ready")).toBe(true);
      expect(canSkipEntry("running")).toBe(false);
      expect(canSkipEntry("merged")).toBe(false);
    });

    it("allows retry only for failed, skipped or cancelled entries", () => {
      expect(canRetryEntry("failed")).toBe(true);
      expect(canRetryEntry("skipped")).toBe(true);
      expect(canRetryEntry("cancelled")).toBe(true);
      expect(canRetryEntry("waiting")).toBe(false);
      expect(canRetryEntry("done")).toBe(false);
    });
  });

  describe("queueTitle", () => {
    it("collapses whitespace and keeps short prompts whole", () => {
      expect(queueTitle("  Start   BIT-1\n to BIT-3 ")).toBe("Start BIT-1 to BIT-3");
    });

    it("cuts long prompts with an ellipsis inside the limit", () => {
      const title = queueTitle("x".repeat(200));
      expect(title).toHaveLength(80);
      expect(title.endsWith("…")).toBe(true);
    });
  });

  describe("laneProgress", () => {
    it("counts running, waiting (waiting and ready), merged, done and failed per lane", () => {
      const [lane] = laneProgress([
        entry("1", { state: "running" }),
        entry("2", { state: "waiting" }),
        entry("3", { state: "ready" }),
        entry("4", { state: "merged" }),
        entry("5", { state: "done" }),
        entry("6", { state: "failed" }),
      ]);
      expect(lane).toMatchObject({ projectKey: "BIT", running: 1, waiting: 2, merged: 1, done: 1, failed: 1 });
      expect(lane?.label).toBe("BIT: 1 running, 2 waiting, 1 merged, 1 done, 1 failed");
    });

    it("keeps one line per lane, keyed by the project", () => {
      const lanes = laneProgress([
        entry("1", { state: "running" }),
        entry("2", { lane: "lane-other", taskCode: "KMZ-2" }),
      ]);
      expect(lanes.map((lane) => lane.label)).toEqual(["BIT: 1 running", "KMZ: 1 waiting"]);
    });

    it("reads nothing active when every entry is closed", () => {
      const [lane] = laneProgress([entry("1", { state: "skipped" })]);
      expect(lane?.label).toBe("BIT: nothing active");
    });

    it("falls back to the lane id when no entry carries a task code", () => {
      const [lane] = laneProgress([entry("1", { state: "running", taskCode: undefined })]);
      expect(lane?.projectKey).toBe(LANE);
    });
  });

  describe("nextLevelUp", () => {
    it("returns the level one step above the entry's current level", () => {
      expect(nextLevelUp(levels, { providerInstanceId: "p", model: "small" })?.key).toBe("mid");
      expect(nextLevelUp(levels, { providerInstanceId: "p", model: "medium" })?.key).toBe("strong");
    });

    it("returns null at the highest level, for unknown models, and without a selection", () => {
      expect(nextLevelUp(levels, { providerInstanceId: "p", model: "large" })).toBeNull();
      expect(nextLevelUp(levels, { providerInstanceId: "p", model: "unknown" })).toBeNull();
      expect(nextLevelUp(levels, null)).toBeNull();
    });

    it("matches the provider as well as the model", () => {
      expect(nextLevelUp(levels, { providerInstanceId: "other", model: "small" })).toBeNull();
    });

    it("sorts by order rather than list position", () => {
      const shuffled = [levels[2], levels[0], levels[1]].filter((level): level is RunLevel => level !== undefined);
      expect(nextLevelUp(shuffled, { providerInstanceId: "p", model: "small" })?.key).toBe("mid");
    });
  });

  describe("applyRealtimeEvent", () => {
    const queueUpdate = (state: WorkQueueView["state"]) => ({
      id: QUEUE,
      orgId: "org",
      createdBy: "Emre",
      prompt: "Start BIT-1",
      state,
      createdAt: AT,
      updatedAt: AT,
    });

    it("keeps entries when a queue's fields change", () => {
      const [updated] = applyRealtimeEvent([queue()], { type: "work_queue.updated", queue: queueUpdate("paused") }) ?? [];
      expect(updated?.state).toBe("paused");
      expect(updated?.entries).toHaveLength(1);
    });

    it("drops a queue that has closed", () => {
      expect(applyRealtimeEvent([queue()], { type: "work_queue.updated", queue: queueUpdate("done") })).toEqual([]);
    });

    it("returns null for a queue it does not have", () => {
      expect(applyRealtimeEvent([], { type: "work_queue.updated", queue: queueUpdate("active") })).toBeNull();
    });

    it("replaces an entry and keeps the task code it already had", () => {
      const [updated] = applyRealtimeEvent([queue()], {
        type: "work_queue_item.updated",
        entry: entry("1", { state: "running", taskCode: undefined }),
      }) ?? [];
      expect(updated?.entries[0]).toMatchObject({ state: "running", taskCode: "BIT-1" });
    });

    it("appends an entry that the queue does not list yet", () => {
      const [updated] = applyRealtimeEvent([queue()], {
        type: "work_queue_item.updated",
        entry: {
          id: "2",
          queueId: QUEUE,
          taskId: "task-2",
          position: 1,
          lane: LANE,
          state: "waiting",
          waitingReason: null,
          resolvedSelection: null,
          umbrellaTaskId: null,
          createdAt: AT,
          updatedAt: AT,
        },
      }) ?? [];
      expect(updated?.entries.map((item) => item.id)).toEqual(["1", "2"]);
    });

    it("returns null for an entry whose queue is not in the list", () => {
      expect(applyRealtimeEvent([queue()], { type: "work_queue_item.updated", entry: { ...entry("9"), queueId: "gone" } })).toBeNull();
    });

    it("returns the list unchanged for other events", () => {
      const queues = [queue()];
      expect(applyRealtimeEvent(queues, { type: "project.deleted", id: "p-1" })).toBe(queues);
    });
  });
});
