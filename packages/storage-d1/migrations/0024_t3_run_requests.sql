CREATE TABLE `t3_run_requests` (
  `sequence` integer PRIMARY KEY AUTOINCREMENT,
  `id` text NOT NULL UNIQUE,
  `org_id` text NOT NULL,
  `task_id` text NOT NULL REFERENCES `tasks` (`id`) ON DELETE CASCADE,
  `kind` text NOT NULL,
  `payload` text NOT NULL,
  `state` text NOT NULL DEFAULT 'queued',
  `claim_token` text,
  `lease_until` integer,
  `attempted` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `t3_run_requests_pending_idx` ON `t3_run_requests` (`org_id`, `task_id`, `state`, `sequence`);
