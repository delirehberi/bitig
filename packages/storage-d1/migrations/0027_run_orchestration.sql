CREATE TABLE `run_levels` (
  `org_id` text NOT NULL REFERENCES `organisations` (`id`) ON DELETE CASCADE,
  `key` text NOT NULL,
  `label` text NOT NULL,
  `description` text NOT NULL,
  `sort_order` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_levels_org_key_unique` ON `run_levels` (`org_id`, `key`);
--> statement-breakpoint
CREATE INDEX `run_levels_org_sort_idx` ON `run_levels` (`org_id`, `sort_order`);
--> statement-breakpoint
CREATE TABLE `run_level_models` (
  `org_id` text NOT NULL REFERENCES `organisations` (`id`) ON DELETE CASCADE,
  `level_key` text NOT NULL,
  `host_id` text,
  `provider_instance_id` text NOT NULL,
  `model` text NOT NULL,
  `options` text,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_level_models_org_level_host_unique` ON `run_level_models` (`org_id`, `level_key`, `host_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_level_models_org_level_default_unique` ON `run_level_models` (`org_id`, `level_key`) WHERE `host_id` IS NULL;
--> statement-breakpoint
CREATE TABLE `org_ai_router_settings` (
  `org_id` text PRIMARY KEY NOT NULL REFERENCES `organisations` (`id`) ON DELETE CASCADE,
  `base_url` text NOT NULL,
  `model` text NOT NULL,
  `api_style` text DEFAULT 'cloudflare-run' NOT NULL,
  `encrypted_api_token` text,
  `token_iv` text,
  `token_last4` text,
  `enabled` integer DEFAULT 0 NOT NULL,
  `updated_by` text,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_run_profiles` (
  `task_id` text PRIMARY KEY NOT NULL REFERENCES `tasks` (`id`) ON DELETE CASCADE,
  `level_key` text,
  `provider_instance_id` text,
  `model` text,
  `options` text,
  `touches` text,
  `parallel_safe` integer,
  `source` text NOT NULL,
  `reason` text,
  `confidence` real,
  `updated_by` text,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_run_settings` (
  `project_id` text PRIMARY KEY NOT NULL REFERENCES `projects` (`id`) ON DELETE CASCADE,
  `default_run_level` text,
  `serial_paths` text,
  `max_parallel_children` integer DEFAULT 3 NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_run_children` (
  `parent_task_id` text NOT NULL REFERENCES `tasks` (`id`) ON DELETE CASCADE,
  `child_task_id` text NOT NULL REFERENCES `tasks` (`id`) ON DELETE CASCADE,
  `state` text NOT NULL,
  `branch` text,
  `head_sha` text,
  `merged_at` integer,
  `merged_sha` text,
  `started_at` integer NOT NULL,
  `finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_children_parent_child_unique` ON `agent_run_children` (`parent_task_id`, `child_task_id`);
--> statement-breakpoint
CREATE INDEX `agent_run_children_parent_task_id_idx` ON `agent_run_children` (`parent_task_id`);
--> statement-breakpoint
CREATE INDEX `agent_run_children_child_task_id_idx` ON `agent_run_children` (`child_task_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `agent_run_children` (`parent_task_id`, `child_task_id`, `state`, `branch`, `head_sha`, `started_at`, `finished_at`)
SELECT
  parent.`task_id`,
  parent.`waiting_for_task_id`,
  CASE
    WHEN child_task.`status` IN ('done', 'archived') THEN 'done'
    WHEN child_task.`needs_human` IS NOT NULL THEN 'needs_human'
    WHEN child_run.`state` = 'failed' THEN 'failed'
    WHEN child_run.`state` = 'stopped' THEN 'stopped'
    ELSE 'running'
  END,
  child_run.`branch`,
  child_run.`head_sha`,
  COALESCE(child_run.`started_at`, parent.`updated_at`),
  CASE
    WHEN child_task.`status` IN ('done', 'archived') THEN COALESCE(child_task.`completed_at`, child_run.`updated_at`, parent.`updated_at`)
    WHEN child_task.`needs_human` IS NOT NULL OR child_run.`state` IN ('failed', 'stopped') THEN COALESCE(child_run.`updated_at`, parent.`updated_at`)
    ELSE NULL
  END
FROM `agent_runs` parent
JOIN `tasks` child_task ON child_task.`id` = parent.`waiting_for_task_id`
LEFT JOIN `agent_runs` child_run ON child_run.`task_id` = parent.`waiting_for_task_id`
WHERE parent.`waiting_for_task_id` IS NOT NULL;
