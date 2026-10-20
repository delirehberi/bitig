CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text DEFAULT 'generic' NOT NULL,
	`token` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`mapping` text,
	`default_priority` text,
	`default_labels` text,
	`trigger_count` integer DEFAULT 0 NOT NULL,
	`last_triggered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhooks_project_id_idx` ON `webhooks` (`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhooks_token_idx` ON `webhooks` (`token`);

