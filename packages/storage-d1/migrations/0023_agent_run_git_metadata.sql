ALTER TABLE `agent_runs` ADD `branch` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `head_sha` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `diff_stat` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `pull_request_urls` text;
