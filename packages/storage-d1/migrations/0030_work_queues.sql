CREATE TABLE `work_queues` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL,
	`created_by` text NOT NULL,
	`prompt` text NOT NULL,
	`state` text DEFAULT 'planning' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `work_queues_org_state_idx` ON `work_queues` (`org_id`, `state`);
--> statement-breakpoint
CREATE TABLE `work_queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`queue_id` text NOT NULL,
	`task_id` text NOT NULL,
	`position` integer NOT NULL,
	`lane` text NOT NULL,
	`state` text DEFAULT 'waiting' NOT NULL,
	`waiting_reason` text,
	`resolved_selection` text,
	`umbrella_task_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`queue_id`) REFERENCES `work_queues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_queue_items_queue_position_idx` ON `work_queue_items` (`queue_id`, `position`);
--> statement-breakpoint
CREATE INDEX `work_queue_items_task_id_idx` ON `work_queue_items` (`task_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_queue_items_one_active_per_task_idx` ON `work_queue_items` (`task_id`) WHERE `state` IN ('waiting', 'ready', 'running', 'merged');
--> statement-breakpoint
ALTER TABLE `t3_connections` ADD `max_parallel_runs` integer;
