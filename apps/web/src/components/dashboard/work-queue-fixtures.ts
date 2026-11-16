import type { Project, RunLevel, T3ModelCapability } from "@bitig/core";
import type { WorkQueueConfirmResult, WorkQueuePlanRow, WorkQueuePlanView } from "../../services/work-queue";

const CREATED_AT = "2026-11-16T00:00:00.000Z";
const BIT_PROJECT_ID = "01940000-0000-7000-8000-0000000000b1";

export const WQ_PROJECTS: Project[] = [
  {
    id: BIT_PROJECT_ID,
    name: "Bitig",
    key: "BIT",
    description: "",
    kind: "open_source",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
  {
    id: "01940000-0000-7000-8000-0000000000b2",
    name: "Komuz",
    key: "KMZ",
    description: "",
    kind: "hobby",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
];

export const WQ_LEVELS: RunLevel[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Small edits",
    order: 0,
    selection: { providerInstanceId: "claudeAgent", model: "claude-haiku-5-5" },
  },
  {
    key: "strong",
    label: "Strong",
    description: "Hard problems",
    order: 1,
    selection: { providerInstanceId: "claudeAgent", model: "claude-opus-5-5" },
  },
];

export const WQ_CAPABILITIES: T3ModelCapability[] = [
  {
    providerInstanceId: "claudeAgent",
    model: "claude-haiku-5-5",
    label: "Haiku",
    options: [{ id: "effort", values: ["low", "medium", "high"] }],
  },
  {
    providerInstanceId: "claudeAgent",
    model: "claude-opus-5-5",
    label: "Opus",
    options: [{ id: "effort", values: ["low", "medium", "high"] }],
  },
];

function taskId(number: number): string {
  return `01940000-0000-7000-8000-${String(number).padStart(12, "0")}`;
}

const CHEAP_RUN = {
  level: "cheap",
  providerInstanceId: "claudeAgent",
  model: "claude-haiku-5-5",
  effort: "low",
  source: "router",
  selection: { providerInstanceId: "claudeAgent", model: "claude-haiku-5-5" },
} as const;

export function row(number: number, overrides: Partial<WorkQueuePlanRow> = {}): WorkQueuePlanRow {
  return {
    code: `BIT-${String(number)}`,
    raw: `BIT-${String(number)}`,
    classification: "ready",
    queueable: true,
    taskId: taskId(number),
    title: `Task ${String(number)}`,
    projectId: BIT_PROJECT_ID,
    run: CHEAP_RUN,
    ...overrides,
  };
}

/** "Start BIT-92 to BIT-95 and KOM-3": two ready, one after BIT-92, one pending approval, one unknown key. */
export function samplePlan(rows: readonly WorkQueuePlanRow[] = defaultRows()): WorkQueuePlanView {
  return {
    parse: {
      items: rows.map((entry) => ({ code: entry.code, raw: entry.raw })),
      unknownKeys: [{ key: "KOM", suggestions: ["KMZ"] }],
      unparsed: [],
      warnings: ["AI parse fallback skipped (router disabled); showing the deterministic result."],
      fallback: "router_unavailable",
    },
    rows,
    lanes: [
      {
        projectId: BIT_PROJECT_ID,
        projectKey: "BIT",
        projectName: "Bitig",
        needsQueueUmbrella: true,
        codes: rows.map((entry) => entry.code),
        waves: [
          {
            number: 1,
            codes: ["BIT-92", "BIT-93"],
            skipped: [{ code: "BIT-94", reason: "dependency", message: "Waiting for BIT-92" }],
          },
          { number: 2, codes: ["BIT-94"], skipped: [] },
        ],
      },
    ],
    routing: { enabled: true, attempted: 2, failed: 0 },
  };
}

export function defaultRows(): WorkQueuePlanRow[] {
  return [
    row(92),
    row(93),
    row(94, { classification: "after_queued_task", related: ["BIT-92"] }),
    row(95, { classification: "needs_approval", queueable: false }),
    row(96, { classification: "needs_approval", queueable: false }),
    row(97, { classification: "unlisted_parent", queueable: false, related: ["BIT-183"], run: undefined }),
  ];
}

export function confirmResult(plan: WorkQueuePlanView, codes: readonly string[]): WorkQueueConfirmResult {
  return {
    queue: {
      id: "01940000-0000-7000-8000-00000000a001",
      orgId: "01940000-0000-7000-8000-00000000a002",
      createdBy: "01940000-0000-7000-8000-00000000a003",
      prompt: "Start",
      state: "active",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      entries: codes.map((code, position) => ({
        id: `01940000-0000-7000-8000-0000000b${String(position).padStart(4, "0")}`,
        queueId: "01940000-0000-7000-8000-00000000a001",
        taskId: taskId(position),
        position,
        lane: BIT_PROJECT_ID,
        state: "waiting",
        waitingReason: null,
        resolvedSelection: null,
        umbrellaTaskId: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        taskCode: code,
      })),
    },
    umbrellas: [{ projectId: BIT_PROJECT_ID, taskId: taskId(300), code: "BIT-300", title: "Queue", children: [...codes] }],
    approved: [],
    plan,
  };
}
