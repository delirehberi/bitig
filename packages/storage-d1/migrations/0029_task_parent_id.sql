ALTER TABLE `tasks` ADD `parent_id` text;
--> statement-breakpoint
CREATE INDEX `tasks_parent_id_idx` ON `tasks` (`parent_id`);
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `hierarchy_mode` text;
