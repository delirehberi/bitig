/**
 * Pure edits on a task's checklist. Storage only ever replaces the whole list
 * (`updateTask({ checklist })`), so every client builds the next list with
 * these and sends it back. Positions are 0-based; out-of-range positions throw
 * `RangeError` so a stale index never edits the wrong item.
 */
import type { ChecklistItem } from "./types";

export interface ChecklistProgress {
  readonly done: number;
  readonly total: number;
}

export function checklistProgress(checklist: readonly ChecklistItem[] | undefined): ChecklistProgress {
  const items = checklist ?? [];
  return { done: items.filter((item) => item.done).length, total: items.length };
}

function assertIndex(checklist: readonly ChecklistItem[], index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= checklist.length) {
    throw new RangeError(`No checklist item at position ${String(index + 1)} (the list has ${String(checklist.length)})`);
  }
}

export function addChecklistItem(checklist: readonly ChecklistItem[] | undefined, text: string): ChecklistItem[] {
  return [...(checklist ?? []), { text, done: false }];
}

export function setChecklistItemDone(
  checklist: readonly ChecklistItem[],
  index: number,
  done: boolean,
): ChecklistItem[] {
  assertIndex(checklist, index);
  return checklist.map((item, i) => {
    if (i !== index) return { ...item };
    const next: ChecklistItem = { text: item.text, done };
    if (item.startedAt !== undefined) next.startedAt = item.startedAt;
    if (done && item.completedAt !== undefined) next.completedAt = item.completedAt;
    return next;
  });
}

export function startChecklistItem(
  checklist: readonly ChecklistItem[],
  index: number,
  startedAt: string,
): ChecklistItem[] {
  assertIndex(checklist, index);
  return checklist.map((item, i) => (i === index ? { ...item, startedAt } : { ...item }));
}

export function renameChecklistItem(checklist: readonly ChecklistItem[], index: number, text: string): ChecklistItem[] {
  assertIndex(checklist, index);
  return checklist.map((item, i) => (i === index ? { ...item, text } : { ...item }));
}

export function moveChecklistItem(checklist: readonly ChecklistItem[], from: number, to: number): ChecklistItem[] {
  assertIndex(checklist, from);
  assertIndex(checklist, to);
  const next = checklist.map((item) => ({ ...item }));
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

export function removeChecklistItem(checklist: readonly ChecklistItem[], index: number): ChecklistItem[] {
  assertIndex(checklist, index);
  return checklist.filter((_, i) => i !== index).map((item) => ({ ...item }));
}
