CREATE TABLE `project_t3_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`t3_project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`title` text NOT NULL,
	`link` text,
	`state` text NOT NULL,
	`model` text,
	`provider_instance_id` text,
	`model_options` text,
	`workspace_strategy` text NOT NULL,
	`started_by` text,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_t3_threads_thread_id_idx` ON `project_t3_threads` (`thread_id`);--> statement-breakpoint
CREATE INDEX `project_t3_threads_project_id_idx` ON `project_t3_threads` (`project_id`);