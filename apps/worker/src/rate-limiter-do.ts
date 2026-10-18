import { DurableObject } from "cloudflare:workers";

const MS_PER_SECOND = 1000;
const MIN_RESET_SECONDS = 1;

export interface RateLimitResult {
  limited: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

/**
 * Sliding-window log for a single key (one instance per `policy:ip`, addressed
 * with `idFromName`). Timestamps live in the Durable Object's SQLite storage, so
 * counters are shared by every isolate and survive eviction of the object.
 */
export class RateLimiter extends DurableObject<Env> {
  private schemaReady = false;

  /** Checks the window and, when the caller is under the limit, counts this hit. */
  async hit(max: number, windowMs: number, now: number = Date.now()): Promise<RateLimitResult> {
    const result = this.evaluate(max, windowMs, now);
    if (result.limited) return result;
    await this.insert(windowMs, now);
    return { ...result, remaining: Math.max(0, result.remaining - 1) };
  }

  /** Checks the window without counting anything. */
  peek(max: number, windowMs: number, now: number = Date.now()): RateLimitResult {
    return this.evaluate(max, windowMs, now);
  }

  /** Counts an event without checking the limit (e.g. a failed login). */
  async record(windowMs: number, now: number = Date.now()): Promise<void> {
    await this.insert(windowMs, now);
  }

  /**
   * The alarm is always moved to `latest write + windowMs`, so by the time it
   * fires every stored timestamp is outside the window and the whole object can
   * be cleared, leaving no storage behind for idle clients.
   */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.schemaReady = false;
  }

  private evaluate(max: number, windowMs: number, now: number): RateLimitResult {
    const sql = this.sql();
    sql.exec("DELETE FROM hits WHERE ts <= ?", now - windowMs);
    const row = sql
      .exec<{ count: number; oldest: number | null }>("SELECT COUNT(*) AS count, MIN(ts) AS oldest FROM hits")
      .one();

    if (row.count >= max) {
      const oldest = row.oldest ?? now;
      return {
        limited: true,
        limit: max,
        remaining: 0,
        resetSeconds: Math.max(MIN_RESET_SECONDS, Math.ceil((oldest + windowMs - now) / MS_PER_SECOND)),
      };
    }

    return {
      limited: false,
      limit: max,
      remaining: max - row.count,
      resetSeconds: Math.ceil(windowMs / MS_PER_SECOND),
    };
  }

  private async insert(windowMs: number, now: number): Promise<void> {
    this.sql().exec("INSERT INTO hits (ts) VALUES (?)", now);
    await this.ctx.storage.setAlarm(now + windowMs);
  }

  private sql(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.schemaReady) {
      sql.exec("CREATE TABLE IF NOT EXISTS hits (ts INTEGER NOT NULL)");
      sql.exec("CREATE INDEX IF NOT EXISTS hits_ts ON hits (ts)");
      this.schemaReady = true;
    }
    return sql;
  }
}
