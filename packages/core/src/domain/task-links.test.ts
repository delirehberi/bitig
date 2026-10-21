import { describe, expect, it } from "vitest";
import { buildMentionIndex } from "./task-links";
import type { Project, Task } from "./types";

const NOW = "2026-10-21T12:00:00.000Z";
const BIT: Project = { id: "p1", name: "Bitig", key: "BIT", description: "", kind: "hobby", createdAt: NOW, updatedAt: NOW };
const OPS: Project = { ...BIT, id: "p2", name: "Ops", key: "OPS" };

function task(id: string, project: Project, number: number | undefined, fields: Partial<Task> = {}): Task {
  return {
    id,
    projectId: project.id,
    ...(number === undefined ? {} : { number }),
    title: `Task ${id}`,
    description: "",
    status: "todo",
    isPublic: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  };
}

describe("buildMentionIndex", () => {
  const target = task("a", BIT, 64, { description: "Follows #BIT-63 and #OPS-1, not #BIT-999 or itself #BIT-64" });
  const dependency = task("b", BIT, 63, { status: "done" });
  const ops = task("c", OPS, 1);
  const fromSubtask = task("d", BIT, 70, { checklist: [{ text: "Wait for #BIT-64", done: false }] });
  const uncoded = task("e", BIT, undefined, { description: "Also #bit-64? no, but #BIT-064 yes" });
  const index = buildMentionIndex([target, dependency, ops, fromSubtask, uncoded], [BIT, OPS]);

  it("lists what a task mentions, resolved and in order, skipping unknown codes and itself", () => {
    expect(index.linksFor(target).mentions).toEqual([
      { id: "b", code: "BIT-63", title: "Task b", status: "done" },
      { id: "c", code: "OPS-1", title: "Task c", status: "todo" },
    ]);
  });

  it("lists the tasks that mention it from descriptions and subtasks, coded or not", () => {
    expect(index.linksFor(target).mentionedIn).toEqual([
      { id: "d", code: "BIT-70", title: "Task d", status: "todo" },
      { id: "e", title: "Task e", status: "todo" },
    ]);
    expect(index.linksFor(dependency).mentionedIn.map((t) => t.id)).toEqual(["a"]);
  });

  it("adds what the task's own comments mention", () => {
    const links = index.linksFor(ops, [{ body: "Blocked on #BIT-70" }, { body: "and #OPS-1 itself" }]);
    expect(links.mentions.map((t) => t.code)).toEqual(["BIT-70"]);
  });

  it("gives a task without a code no backlinks", () => {
    expect(index.linksFor(uncoded)).toEqual({
      mentions: [{ id: "a", code: "BIT-64", title: "Task a", status: "todo" }],
      mentionedIn: [],
    });
  });
});
