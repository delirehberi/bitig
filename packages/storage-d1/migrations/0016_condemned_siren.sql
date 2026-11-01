CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`t3_project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`link` text,
	`state` text NOT NULL,
	`model` text,
	`workspace_strategy` text,
	`started_by` text,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_task_id_idx` ON `agent_runs` (`task_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_thread_id_idx` ON `agent_runs` (`thread_id`);--> statement-breakpoint
CREATE TABLE `t3_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`mcp_url` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`encrypted_access_token` text NOT NULL,
	`token_iv` text NOT NULL,
	`scope` text NOT NULL,
	`expires_at` integer NOT NULL,
	`connected_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `t3_oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`mcp_url` text NOT NULL,
	`issuer` text NOT NULL,
	`token_endpoint` text NOT NULL,
	`client_id` text NOT NULL,
	`code_verifier` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `t3_project_mappings` (
	`project_id` text PRIMARY KEY NOT NULL,
	`t3_project_id` text NOT NULL,
	`t3_project_title` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
