import type { SaveAgentRunInput } from "./t3-store";

/** Longer than one bounded MCP call; expired claims retry with the original host request ID. */
export const T3_REQUEST_LEASE_MS = 120_000;

export interface T3QueuedRequest {
  id: string;
  host_id: string | null;
  task_id: string;
  kind: "launch" | "reply" | "message";
  payload: string;
  claim_token: string | null;
  attempted: number;
}

/** The outbox and its visible run state change together in D1 transactions. */
export class T3RequestStore {
  constructor(private readonly d1: D1Database, private readonly orgId: string) {}

  async enqueue(input: {
    id: string;
    hostId?: string | null | undefined;
    taskId: string;
    kind: T3QueuedRequest["kind"];
    payload: string;
    now: number;
    launch?: SaveAgentRunInput;
  }): Promise<void> {
    const resolvedHostId = input.hostId ?? input.launch?.hostId ?? null;
    const insert = this.d1.prepare(`INSERT INTO t3_run_requests
      (id, org_id, host_id, task_id, kind, payload, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ? != 'launch' OR NOT EXISTS (
        SELECT 1 FROM t3_run_requests WHERE org_id = ? AND task_id = ? AND state IN ('queued', 'dispatching')
      ) ON CONFLICT(id) DO NOTHING`).bind(
      input.id, this.orgId, resolvedHostId, input.taskId, input.kind, input.payload, input.now,
      input.kind, this.orgId, input.taskId,
    );
    const run = input.launch;
    const modelOptionsJson =
      run?.modelOptions && run.modelOptions.length > 0 ? JSON.stringify(run.modelOptions) : null;
    const update = run
      ? this.d1.prepare(`INSERT INTO agent_runs
          (id, task_id, host_id, t3_project_id, thread_id, state, model, provider_instance_id,
           model_options, workspace_strategy, parent_task_id, started_by, started_at, updated_at)
          SELECT ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM t3_run_requests WHERE id = ? AND org_id = ? AND state = 'queued')
          ON CONFLICT(task_id) DO UPDATE SET id = excluded.id, host_id = excluded.host_id,
            t3_project_id = excluded.t3_project_id,
            thread_id = excluded.thread_id, state = 'queued', model = excluded.model,
            provider_instance_id = excluded.provider_instance_id, model_options = excluded.model_options,
            workspace_strategy = excluded.workspace_strategy,
            parent_task_id = excluded.parent_task_id, started_by = excluded.started_by,
            started_at = excluded.started_at, updated_at = excluded.updated_at,
            link = NULL, waiting_for_task_id = NULL,
            branch = NULL, head_sha = NULL, diff_stat = NULL, pull_request_urls = NULL`).bind(
          run.id, run.taskId, run.hostId ?? resolvedHostId, run.t3ProjectId, run.threadId, run.model ?? null,
          run.providerInstanceId ?? null, modelOptionsJson, run.workspaceStrategy ?? null, run.parentTaskId ?? null,
          run.startedBy ?? null, run.startedAt, run.updatedAt, input.id, this.orgId,
        )
      : this.d1.prepare(`UPDATE agent_runs SET state = 'queued', updated_at = ? WHERE task_id = ?
          AND EXISTS (SELECT 1 FROM t3_run_requests WHERE id = ? AND org_id = ? AND state = 'queued')`)
        .bind(input.now, input.taskId, input.id, this.orgId);
    await this.d1.batch([insert, update]);
  }

  async hasPending(taskId: string): Promise<boolean> {
    const row = await this.d1.prepare(`SELECT id FROM t3_run_requests
      WHERE org_id = ? AND task_id = ? AND state IN ('queued', 'dispatching') LIMIT 1`)
      .bind(this.orgId, taskId).first<{ id: string }>();
    return row !== null;
  }

  async listPendingTaskIds(): Promise<string[]> {
    const rows = await this.d1.prepare(`SELECT DISTINCT task_id FROM t3_run_requests
      WHERE org_id = ? AND state IN ('queued', 'dispatching') ORDER BY sequence`)
      .bind(this.orgId).all<{ task_id: string }>();
    return rows.results.map((r) => r.task_id);
  }

  async claim(taskId: string, token: string, now: number): Promise<T3QueuedRequest | null> {
    const claim = this.d1.prepare(`UPDATE t3_run_requests SET state = 'dispatching', claim_token = ?, lease_until = ?
      WHERE sequence = (SELECT sequence FROM t3_run_requests WHERE org_id = ? AND task_id = ?
        AND state IN ('queued', 'dispatching') ORDER BY sequence LIMIT 1)
      AND (state = 'queued' OR lease_until <= ?) RETURNING id, host_id, task_id, kind, payload, claim_token, attempted`)
      .bind(token, now + T3_REQUEST_LEASE_MS, this.orgId, taskId, now);
    const update = this.d1.prepare(`UPDATE agent_runs SET state = 'working', updated_at = ? WHERE task_id = ?
      AND EXISTS (SELECT 1 FROM t3_run_requests WHERE org_id = ? AND task_id = ? AND claim_token = ?)`)
      .bind(now, taskId, this.orgId, taskId, token);
    const results = await this.d1.batch<T3QueuedRequest>([claim, update]);
    return results[0]?.results[0] ?? null;
  }

  async markAttempted(id: string, token: string): Promise<boolean> {
    const result = await this.d1.prepare(`UPDATE t3_run_requests SET attempted = 1
      WHERE id = ? AND org_id = ? AND claim_token = ? AND state = 'dispatching'`)
      .bind(id, this.orgId, token).run();
    return result.meta.changes === 1;
  }

  async finish(request: T3QueuedRequest, state: "delivered" | "queued" | "failed", now: number): Promise<void> {
    // Token fencing prevents an expired dispatcher from finishing a newer dispatcher's claim.
    await this.d1.batch([
      this.d1.prepare(`UPDATE agent_runs SET state = CASE
        WHEN ? = 'queued' THEN 'queued' WHEN ? = 'failed' THEN 'failed'
        WHEN EXISTS (SELECT 1 FROM t3_run_requests WHERE org_id = ? AND task_id = ?
          AND id != ? AND state IN ('queued', 'dispatching')) THEN 'queued' ELSE state END,
        updated_at = ? WHERE task_id = ? AND EXISTS (
          SELECT 1 FROM t3_run_requests WHERE id = ? AND org_id = ? AND claim_token = ? AND state = 'dispatching')`)
        .bind(state, state, this.orgId, request.task_id, request.id, now, request.task_id,
          request.id, this.orgId, request.claim_token),
      this.d1.prepare(`UPDATE t3_run_requests SET state = ?, claim_token = NULL, lease_until = NULL
        WHERE id = ? AND org_id = ? AND claim_token = ? AND state = 'dispatching'`)
        .bind(state, request.id, this.orgId, request.claim_token),
    ]);
  }

  async cancel(taskId: string, now: number): Promise<boolean> {
    // Do not cancel while another caller actively holds a dispatch lease.
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE t3_run_requests SET state = 'cancelled'
        WHERE org_id = ? AND task_id = ? AND state = 'queued' AND NOT EXISTS (
          SELECT 1 FROM t3_run_requests WHERE org_id = ? AND task_id = ?
            AND state = 'dispatching')`)
        .bind(this.orgId, taskId, this.orgId, taskId),
      this.d1.prepare(`UPDATE agent_runs SET state = 'stopped', updated_at = ? WHERE task_id = ?
        AND state = 'queued' AND NOT EXISTS (SELECT 1 FROM t3_run_requests
          WHERE org_id = ? AND task_id = ? AND state IN ('queued', 'dispatching'))`)
        .bind(now, taskId, this.orgId, taskId),
    ]);
    return (results[0]?.meta.changes ?? 0) > 0;
  }
}
