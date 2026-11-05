ALTER TABLE `agent_runs` ADD `parent_task_id` text REFERENCES tasks(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `waiting_for_task_id` text REFERENCES tasks(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `agent_runs_waiting_for_task_id_idx` ON `agent_runs` (`waiting_for_task_id`);
