import { Archive, ExternalLink, Inbox } from "lucide-react";
import { useState } from "react";
import type { Task } from "@bitig/core";
import { formatFullTimestamp, formatTimeAgo } from "../../domain/time-ago";
import { Link } from "../../routing/Link";
import { taskHref, useLocationHref } from "../../routing/router";
import { T3GitBadges } from "../tasks/T3GitBadges";
import type { AttentionItem, AttentionReason } from "./dashboard-model";

interface NeedsYouProps {
  readonly items: readonly AttentionItem[];
  readonly now: Date;
  readonly onArchiveTask?: ((task: Task) => void) | undefined;
}

/** Rows shown before "Show more", so a backlog of reviews cannot push the page down. */
export const NEEDS_YOU_VISIBLE_LIMIT = 8;

const REASON_LABELS: Record<AttentionReason, string> = {
  thread_waiting: "Agent is waiting for you",
  needs_human: "Question for you",
  agent_stopped: "Agent stopped",
  review_done: "Ready for review",
};

/** `agent_stopped` rows name how the run ended. */
const STOPPED_LABELS: Readonly<Record<string, string>> = {
  finished: "Agent finished",
  failed: "Agent failed",
  stopped: "Agent stopped",
};

const REASON_CHIP_CLASSES: Record<AttentionReason, string> = {
  thread_waiting: "border-danger/40 bg-danger-soft text-danger",
  needs_human: "border-accent/40 bg-accent-soft text-accent-ink",
  agent_stopped: "border-rule-strong bg-paper-3 text-ink",
  review_done: "border-ok/40 bg-ok-soft text-ok",
};

/** The open-task link reads as the action the person takes there. */
const OPEN_TASK_LABELS: Record<AttentionReason, string> = {
  thread_waiting: "Respond",
  needs_human: "Answer",
  agent_stopped: "Review",
  review_done: "Open",
};

const BUTTON_CLASS =
  "inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2 py-1 text-2xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink focus-visible:outline-focus";

function reasonLabel(item: AttentionItem): string {
  if (item.reason === "agent_stopped" && item.detail !== undefined) {
    return STOPPED_LABELS[item.detail] ?? REASON_LABELS.agent_stopped;
  }
  return REASON_LABELS[item.reason];
}

function NeedsYouRow({
  item,
  now,
  locationHref,
  onArchiveTask,
}: {
  readonly item: AttentionItem;
  readonly now: Date;
  readonly locationHref: string;
  readonly onArchiveTask?: ((task: Task) => void) | undefined;
}) {
  const { task, code } = item;
  const label = code ? `${code} ${item.title}` : item.title;
  const href = task === undefined ? undefined : taskHref(code ?? task.id, locationHref);

  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-rule bg-paper-2 p-3" data-reason={item.reason}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span
            className={`inline-flex w-fit items-center rounded-pill border px-2 py-0.5 text-2xs font-semibold ${REASON_CHIP_CLASSES[item.reason]}`}
          >
            {reasonLabel(item)}
          </span>
          {href === undefined ? (
            <span className="truncate text-sm font-semibold text-ink">{item.title}</span>
          ) : (
            <Link
              href={href}
              aria-label={label}
              className="flex min-w-0 items-baseline gap-2 text-sm font-semibold text-ink hover:text-accent-ink hover:underline"
            >
              {code && <span className="shrink-0 font-mono text-xs text-ink-3">{code}</span>}
              <span className="truncate">{item.title}</span>
            </Link>
          )}
          <span className="text-xs text-ink-3">
            {item.project?.name ?? "Unknown project"}
            {item.since && (
              <>
                {" · waiting since "}
                <time dateTime={item.since} title={formatFullTimestamp(item.since)}>
                  {formatTimeAgo(item.since, now)}
                </time>
              </>
            )}
          </span>
          <T3GitBadges
            branch={item.branch}
            headSha={item.headSha}
            diffStat={item.diffStat}
            pullRequestUrls={item.pullRequestUrls}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {item.threadLink && (
            <a
              href={item.threadLink}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${label} in T3`}
              className={BUTTON_CLASS}
            >
              <ExternalLink size={12} aria-hidden="true" />
              <span>Open thread</span>
            </a>
          )}
          {item.reason === "review_done" && task !== undefined && onArchiveTask && (
            <button
              type="button"
              onClick={() => {
                onArchiveTask(task);
              }}
              aria-label={`Archive ${item.title}`}
              className={BUTTON_CLASS}
            >
              <Archive size={12} aria-hidden="true" />
              <span>Archive</span>
            </button>
          )}
          {href !== undefined && (
            <Link href={href} aria-label={`${OPEN_TASK_LABELS[item.reason]}: ${label}`} className={BUTTON_CLASS}>
              {OPEN_TASK_LABELS[item.reason]}
            </Link>
          )}
        </div>
      </div>
      {item.reason === "needs_human" && item.detail && (
        <p className="m-0 line-clamp-3 text-sm text-ink-2">{item.detail}</p>
      )}
    </li>
  );
}

/** Everything that waits on the person, most urgent first. Backlog tasks are left to the Tasks page. */
export function NeedsYou({ items, now, onArchiveTask }: NeedsYouProps) {
  const locationHref = useLocationHref();
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, NEEDS_YOU_VISIBLE_LIMIT);
  const hiddenCount = items.length - visible.length;

  return (
    <section
      aria-labelledby="needs-you-heading"
      className="flex flex-col gap-4 rounded-lg border border-rule bg-paper p-6 shadow-xs"
    >
      <div className="flex items-center gap-2">
        <Inbox size={18} className="text-accent-ink" aria-hidden="true" />
        <h2 id="needs-you-heading" className="m-0 font-display text-lg font-semibold text-ink">
          Needs you
        </h2>
        <span className="rounded-pill bg-accent-soft px-2 py-0.5 font-mono text-xs font-semibold text-accent-ink">
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="m-0 rounded-md border border-dashed border-rule bg-paper-2 p-4 text-sm text-ink-3">
          Nothing needs you right now.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Items waiting on you">
          {visible.map((item) => (
            <NeedsYouRow
              key={item.key}
              item={item}
              now={now}
              locationHref={locationHref}
              onArchiveTask={onArchiveTask}
            />
          ))}
        </ul>
      )}
      {(hiddenCount > 0 || showAll) && items.length > NEEDS_YOU_VISIBLE_LIMIT && (
        <button
          type="button"
          onClick={() => {
            setShowAll(!showAll);
          }}
          className="self-start text-sm font-semibold text-accent-ink hover:underline focus-visible:outline-focus"
        >
          {showAll ? "Show fewer" : `Show ${String(hiddenCount)} more`}
        </button>
      )}
    </section>
  );
}
