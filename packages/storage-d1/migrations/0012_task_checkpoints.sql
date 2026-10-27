CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`step_index` integer NOT NULL,
	`status` text NOT NULL,
	`state_snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkpoints_task_step_idx` ON `checkpoints` (`task_id`,`step_index`);
