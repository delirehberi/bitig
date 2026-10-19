import { describe, expect, it } from "vitest";
import {
  addChecklistItem,
  checklistProgress,
  moveChecklistItem,
  removeChecklistItem,
  renameChecklistItem,
  setChecklistItemDone,
} from "./checklist";
import type { ChecklistItem } from "./types";

const LIST: readonly ChecklistItem[] = [
  { text: "a", done: false },
  { text: "b", done: true },
  { text: "c", done: false },
];

describe("checklist edits", () => {
  it("counts progress, treating no list as empty", () => {
    expect(checklistProgress(LIST)).toEqual({ done: 1, total: 3 });
    expect(checklistProgress(undefined)).toEqual({ done: 0, total: 0 });
  });

  it("adds an unchecked item at the end", () => {
    expect(addChecklistItem(undefined, "x")).toEqual([{ text: "x", done: false }]);
    expect(addChecklistItem(LIST, "d").at(-1)).toEqual({ text: "d", done: false });
  });

  it("checks, renames and removes by position", () => {
    expect(setChecklistItemDone(LIST, 0, true)[0]).toEqual({ text: "a", done: true });
    expect(renameChecklistItem(LIST, 2, "z")[2]).toEqual({ text: "z", done: false });
    expect(removeChecklistItem(LIST, 1).map((i) => i.text)).toEqual(["a", "c"]);
  });

  it("moves an item in either direction", () => {
    expect(moveChecklistItem(LIST, 0, 2).map((i) => i.text)).toEqual(["b", "c", "a"]);
    expect(moveChecklistItem(LIST, 2, 0).map((i) => i.text)).toEqual(["c", "a", "b"]);
  });

  it("never mutates the input", () => {
    const before = LIST.map((item) => ({ ...item }));
    setChecklistItemDone(LIST, 0, true);
    moveChecklistItem(LIST, 0, 2);
    removeChecklistItem(LIST, 0);
    expect(LIST).toEqual(before);
  });

  it("rejects positions outside the list", () => {
    expect(() => setChecklistItemDone(LIST, 3, true)).toThrow(RangeError);
    expect(() => removeChecklistItem(LIST, -1)).toThrow(RangeError);
    expect(() => moveChecklistItem(LIST, 0, 1.5)).toThrow(RangeError);
  });
});
