ALTER TABLE `projects` ADD `key` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `number` integer;--> statement-breakpoint
CREATE INDEX `tasks_project_number_idx` ON `tasks` (`project_id`,`number`);