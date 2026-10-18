import type { StorageProvider } from "@bitig/core";

export interface StorageFactoryOptions {
  /**
   * Create an explicitly configured data directory (--data-dir / BITIG_DATA_DIR)
   * when it is missing. Only commands that bootstrap data (init, import, restore)
   * set this; every other command fails, so a mistyped path is not silently created.
   */
  readonly createDataDir?: boolean;
}

export type StorageFactory = (options?: StorageFactoryOptions) => Promise<StorageProvider>;
