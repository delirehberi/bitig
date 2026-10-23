import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_MAX,
  LABELS_MAX_COUNT,
  LABEL_MAX,
  PROJECT_NAME_MAX,
  TASK_TITLE_MAX,
} from "./constants";
import {
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  DueDateSchema,
  IdSchema,
  LabelsSchema,
  ProjectSchema,
  TaskSchema,
  TimestampSchema,
  UpdateProjectInputSchema,
  UpdateTaskInputSchema,
} from "./schemas";

const ID_A = "0192f0c8-7b4a-7c3e-8f12-3456789abcde";
const ID_B = "0192f0c8-7b4a-7c3e-9f12-3456789abcdf";
const NOW = "2026-10-08T12:00:00.000Z";

describe("IdSchema", () => {
  it("accepts a UUIDv7", () => {
    expect(IdSchema.safeParse(ID_A).success).toBe(true);
  });

  it.each([
    "",
    "not-a-uuid",
    "0192f0c8-7b4a-4c3e-8f12-3456789abcde", // v4
    "../../etc/passwd",
  ])("rejects %s", (value) => {
    expect(IdSchema.safeParse(value).success).toBe(false);
  });
});

describe("TimestampSchema", () => {
  it("accepts UTC ISO timestamps", () => {
    expect(TimestampSchema.safeParse(NOW).success).toBe(true);
  });

  it.each(["2026-10-08T12:00:00+02:00", "2026-10-08", "yesterday"])("rejects %s", (value) => {
    expect(TimestampSchema.safeParse(value).success).toBe(false);
  });
});

describe("DueDateSchema", () => {
  it.each(["2026-10-08", "2028-02-29"])("accepts %s", (value) => {
    expect(DueDateSchema.safeParse(value).success).toBe(true);
  });

  it.each(["2026-02-30", "2027-02-29", "2026-13-01", "2026-10-08T00:00:00Z", "08/10/2026"])(
    "rejects %s",
    (value) => {
      expect(DueDateSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("LabelsSchema", () => {
  it("trims labels", () => {
    expect(LabelsSchema.parse([" work ", "home"])).toEqual(["work", "home"]);
  });

  it("rejects duplicates after trimming", () => {
    expect(LabelsSchema.safeParse(["work", " work"]).success).toBe(false);
  });

  it("rejects empty and oversize labels", () => {
    expect(LabelsSchema.safeParse(["  "]).success).toBe(false);
    expect(LabelsSchema.safeParse(["x".repeat(LABEL_MAX + 1)]).success).toBe(false);
  });

  it("rejects too many labels", () => {
    const labels = Array.from({ length: LABELS_MAX_COUNT + 1 }, (_, i) => `l${String(i)}`);
    expect(LabelsSchema.safeParse(labels).success).toBe(false);
  });
});

describe("CreateProjectInputSchema", () => {
  it("applies defaults", () => {
    expect(CreateProjectInputSchema.parse({ name: "  Bitig  " })).toEqual({
      name: "Bitig",
      description: "",
      kind: "hobby",
    });
  });

  it("accepts an explicit kind", () => {
    expect(CreateProjectInputSchema.parse({ name: "Client", kind: "paid" }).kind).toBe("paid");
  });

  it.each([
    { name: "" },
    { name: "   " },
    { name: "x".repeat(PROJECT_NAME_MAX + 1) },
    { name: "ok", description: "x".repeat(DESCRIPTION_MAX + 1) },
    { name: "ok", kind: "commercial" },
    { name: "ok", extra: true },
    {},
  ])("rejects %o", (input) => {
    expect(CreateProjectInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("UpdateProjectInputSchema", () => {
  it("accepts a partial patch", () => {
    expect(UpdateProjectInputSchema.parse({ kind: "open_source" })).toEqual({
      kind: "open_source",
    });
  });

  it.each([{}, { name: undefined }, { kind: null }, { name: null }, { id: ID_A }])(
    "rejects %o",
    (input) => {
      expect(UpdateProjectInputSchema.safeParse(input).success).toBe(false);
    },
  );
});

describe("CreateTaskInputSchema", () => {
  it("applies defaults", () => {
    expect(CreateTaskInputSchema.parse({ projectId: ID_A, title: " Write tests " })).toEqual({
      projectId: ID_A,
      title: "Write tests",
      description: "",
      status: "todo",
      isPublic: false,
    });
  });

  it("accepts every optional field", () => {
    const input = {
      projectId: ID_A,
      title: "t",
      dueDate: "2026-12-31",
      priority: "trivial",
      labels: ["a"],
      order: 1.5,
    };
    expect(CreateTaskInputSchema.parse(input)).toMatchObject(input);
  });

  it.each([
    { title: "t" },
    { projectId: "nope", title: "t" },
    { projectId: ID_A, title: "" },
    { projectId: ID_A, title: "x".repeat(TASK_TITLE_MAX + 1) },
    { projectId: ID_A, title: "t", status: "unknown" },
    { projectId: ID_A, title: "t", priority: "critical" },
    { projectId: ID_A, title: "t", order: Number.POSITIVE_INFINITY },
    { projectId: ID_A, title: "t", order: Number.NaN },
    { projectId: ID_A, title: "t", id: ID_B },
  ])("rejects %o", (input) => {
    expect(CreateTaskInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("UpdateTaskInputSchema", () => {
  it("accepts null to clear optional fields", () => {
    const patch = { dueDate: null, priority: null, labels: null, order: null };
    expect(UpdateTaskInputSchema.parse(patch)).toEqual(patch);
  });

  it.each([{}, { title: null }, { status: null }, { isPublic: null }, { projectId: null }])(
    "rejects %o",
    (input) => {
      expect(UpdateTaskInputSchema.safeParse(input).success).toBe(false);
    },
  );
});

describe("entity schemas", () => {
  const project = {
    id: ID_A,
    name: "Bitig",
    description: "",
    kind: "internal",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const task = {
    id: ID_B,
    projectId: ID_A,
    title: "t",
    description: "",
    status: "done",
    isPublic: false,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("accept valid entities", () => {
    expect(ProjectSchema.parse(project)).toEqual(project);
    expect(TaskSchema.parse(task)).toEqual(task);
  });

  it("reject a project without kind", () => {
    const withoutKind: Partial<typeof project> = { ...project };
    delete withoutKind.kind;
    expect(ProjectSchema.safeParse(withoutKind).success).toBe(false);
  });

  it("reject optional task fields set to undefined explicitly", () => {
    expect(TaskSchema.safeParse({ ...task, dueDate: undefined }).success).toBe(false);
  });
});
