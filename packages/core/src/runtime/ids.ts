import { v7 as uuidv7 } from "uuid";

/** Produces a new opaque domain ID (UUIDv7). */
export type IdGenerator = () => string;

/** Returns the current instant. Injected so adapters and tests stay deterministic. */
export type Clock = () => Date;

export interface RuntimeDeps {
  readonly generateId: IdGenerator;
  readonly clock: Clock;
}

export const defaultIdGenerator: IdGenerator = () => uuidv7();

export const systemClock: Clock = () => new Date();

export const defaultRuntimeDeps: RuntimeDeps = {
  generateId: defaultIdGenerator,
  clock: systemClock,
};

/** Formats a clock reading as the domain's ISO 8601 UTC timestamp. */
export function toTimestamp(date: Date): string {
  return date.toISOString();
}

