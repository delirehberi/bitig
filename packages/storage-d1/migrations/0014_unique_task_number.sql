DROP INDEX `tasks_project_number_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_number_idx` ON `tasks` (`project_id`,`number`);