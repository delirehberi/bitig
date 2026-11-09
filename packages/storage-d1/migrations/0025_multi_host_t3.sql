DROP INDEX IF EXISTS `t3_connections_org_id_unique`;
--> statement-breakpoint
ALTER TABLE `t3_connections` ADD `label` text;
--> statement-breakpoint
ALTER TABLE `t3_connections` ADD `kind` text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE `t3_connections` ADD `projects_root` text DEFAULT '~/www' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `t3_connections_org_mcp_url_unique` ON `t3_connections` (`org_id`, `mcp_url`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `t3_connections_org_id_idx` ON `t3_connections` (`org_id`);
--> statement-breakpoint
ALTER TABLE `t3_oauth_states` ADD `host_id` text;
--> statement-breakpoint
ALTER TABLE `t3_oauth_states` ADD `label` text;
--> statement-breakpoint
ALTER TABLE `t3_oauth_states` ADD `kind` text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE `t3_oauth_states` ADD `projects_root` text DEFAULT '~/www' NOT NULL;
--> statement-breakpoint
ALTER TABLE `t3_project_mappings` ADD `host_id` text;
--> statement-breakpoint
UPDATE `t3_project_mappings`
SET `host_id` = (
  SELECT c.`id`
  FROM `t3_connections` c
  JOIN `projects` p ON p.`org_id` = c.`org_id`
  WHERE p.`id` = `t3_project_mappings`.`project_id`
  ORDER BY c.`connected_at` ASC, c.`id` ASC
  LIMIT 1
)
WHERE `host_id` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `t3_project_mappings_host_id_idx` ON `t3_project_mappings` (`host_id`);
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `host_id` text;
--> statement-breakpoint
UPDATE `agent_runs`
SET `host_id` = COALESCE(
  (
    SELECT m.`host_id`
    FROM `tasks` t
    JOIN `t3_project_mappings` m ON m.`project_id` = t.`project_id`
    WHERE t.`id` = `agent_runs`.`task_id` AND m.`host_id` IS NOT NULL
    LIMIT 1
  ),
  (
    SELECT c.`id`
    FROM `tasks` t
    JOIN `projects` p ON p.`id` = t.`project_id`
    JOIN `t3_connections` c ON c.`org_id` = p.`org_id`
    WHERE t.`id` = `agent_runs`.`task_id`
    ORDER BY c.`connected_at` ASC, c.`id` ASC
    LIMIT 1
  )
)
WHERE `host_id` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_runs_host_thread_idx` ON `agent_runs` (`host_id`, `thread_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `project_t3_threads_thread_id_idx`;
--> statement-breakpoint
ALTER TABLE `project_t3_threads` ADD `host_id` text;
--> statement-breakpoint
UPDATE `project_t3_threads`
SET `host_id` = COALESCE(
  (
    SELECT m.`host_id`
    FROM `t3_project_mappings` m
    WHERE m.`project_id` = `project_t3_threads`.`project_id` AND m.`host_id` IS NOT NULL
    LIMIT 1
  ),
  (
    SELECT c.`id`
    FROM `projects` p
    JOIN `t3_connections` c ON c.`org_id` = p.`org_id`
    WHERE p.`id` = `project_t3_threads`.`project_id`
    ORDER BY c.`connected_at` ASC, c.`id` ASC
    LIMIT 1
  )
)
WHERE `host_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `project_t3_threads_host_thread_idx` ON `project_t3_threads` (`host_id`, `thread_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `project_t3_threads_thread_id_idx` ON `project_t3_threads` (`thread_id`);
--> statement-breakpoint
ALTER TABLE `t3_run_requests` ADD `host_id` text;
--> statement-breakpoint
UPDATE `t3_run_requests`
SET `host_id` = COALESCE(
  (
    SELECT r.`host_id`
    FROM `agent_runs` r
    WHERE r.`task_id` = `t3_run_requests`.`task_id` AND r.`host_id` IS NOT NULL
    LIMIT 1
  ),
  (
    SELECT m.`host_id`
    FROM `tasks` t
    JOIN `t3_project_mappings` m ON m.`project_id` = t.`project_id`
    WHERE t.`id` = `t3_run_requests`.`task_id` AND m.`host_id` IS NOT NULL
    LIMIT 1
  ),
  (
    SELECT c.`id`
    FROM `t3_connections` c
    WHERE c.`org_id` = `t3_run_requests`.`org_id`
    ORDER BY c.`connected_at` ASC, c.`id` ASC
    LIMIT 1
  )
)
WHERE `host_id` IS NULL;
