CREATE TABLE `feedback_forms` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL REFERENCES `organisations` (`id`) ON DELETE CASCADE,
  `project_id` text NOT NULL REFERENCES `projects` (`id`) ON DELETE CASCADE,
  `public_id` text NOT NULL,
  `name` text NOT NULL,
  `title` text NOT NULL,
  `intro` text DEFAULT '' NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `fields` text NOT NULL,
  `allowed_origins` text NOT NULL,
  `turnstile` integer DEFAULT 1 NOT NULL,
  `default_labels` text,
  `default_priority` text,
  `thank_you_text` text DEFAULT 'Thank you for your feedback.' NOT NULL,
  `accent_color` text,
  `banned_words` text,
  `submission_count` integer DEFAULT 0 NOT NULL,
  `last_submitted_at` integer,
  `created_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_forms_public_id_unique` ON `feedback_forms` (`public_id`);
--> statement-breakpoint
CREATE INDEX `feedback_forms_org_id_idx` ON `feedback_forms` (`org_id`);
--> statement-breakpoint
CREATE INDEX `feedback_forms_project_id_idx` ON `feedback_forms` (`project_id`);
--> statement-breakpoint
CREATE TABLE `feedback_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text REFERENCES `tasks` (`id`) ON DELETE SET NULL,
  `form_id` text NOT NULL REFERENCES `feedback_forms` (`id`) ON DELETE CASCADE,
  `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL REFERENCES `organisations` (`id`) ON DELETE CASCADE,
  `project_id` text NOT NULL REFERENCES `projects` (`id`) ON DELETE CASCADE,
  `outcome` text DEFAULT 'pending' NOT NULL,
  `category` text,
  `submitter_email` text,
  `submitter_name` text,
  `page_url` text,
  `ip_hash` text,
  `body_hash` text,
  `user_agent` text,
  `spam_score` integer DEFAULT 0 NOT NULL,
  `reviewed_by` text,
  `reviewed_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_entries_form_outcome_idx` ON `feedback_entries` (`form_id`, `outcome`);
--> statement-breakpoint
CREATE INDEX `feedback_entries_task_id_idx` ON `feedback_entries` (`task_id`);
--> statement-breakpoint
CREATE INDEX `feedback_entries_duplicate_idx` ON `feedback_entries` (`form_id`, `ip_hash`, `body_hash`, `created_at`);
