import { ExternalLink, GitBranch } from "lucide-react";
import { T3PullRequestUrlSchema, T3_SHORT_SHA_LENGTH, type AgentRun } from "@bitig/core";

export interface T3GitBadgesProps {
  readonly branch?: string | null | undefined;
  readonly headSha?: string | null | undefined;
  readonly diffStat?: AgentRun["diffStat"];
  readonly pullRequestUrls?: readonly string[] | undefined;
  readonly className?: string | undefined;
}

export function T3GitBadges({
  branch,
  headSha,
  diffStat,
  pullRequestUrls,
  className = "",
}: T3GitBadgesProps) {
  const safePrUrls = [...new Set(pullRequestUrls ?? [])].filter(
    (url) => T3PullRequestUrlSchema.safeParse(url).success,
  );
  if (!branch && !headSha && !diffStat && safePrUrls.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="t3-git-badges"
      className={`flex flex-wrap items-center gap-1.5 text-2xs text-ink-2 ${className}`.trim()}
    >
      {branch && (
        <span
          title={`Branch: ${branch}`}
          className="inline-flex items-center gap-1 rounded border border-rule bg-paper-2 px-1.5 py-0.5 font-mono font-medium text-ink"
        >
          <GitBranch size={11} aria-hidden="true" className="shrink-0 text-accent-ink" />
          <span className="max-w-[180px] truncate">{branch}</span>
        </span>
      )}
      {headSha && (
        <code
          title={headSha}
          className="rounded border border-rule bg-paper-2 px-1.5 py-0.5 font-mono text-ink-2"
        >
          {headSha.slice(0, T3_SHORT_SHA_LENGTH)}
        </code>
      )}
      {diffStat && (
        <span
          title={`${String(diffStat.filesChanged)} files changed · +${String(diffStat.insertions)} / −${String(diffStat.deletions)}`}
          className="inline-flex items-center gap-1 rounded border border-rule bg-paper-2 px-1.5 py-0.5 font-mono text-ink-2"
        >
          <span>{diffStat.filesChanged}f</span>
          <span className="text-ok">+{diffStat.insertions}</span>
          <span className="text-danger">−{diffStat.deletions}</span>
        </span>
      )}
      {safePrUrls.map((url) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={url}
          className="inline-flex items-center gap-0.5 rounded border border-accent/30 bg-accent-soft px-1.5 py-0.5 font-semibold text-accent-ink hover:underline"
        >
          <span>PR</span>
          <ExternalLink size={10} aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}
