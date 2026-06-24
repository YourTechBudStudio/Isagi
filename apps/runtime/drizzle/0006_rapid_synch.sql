CREATE TABLE `workflow_run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_run_id` integer NOT NULL,
	`recorded_at` text NOT NULL,
	`state` text NOT NULL,
	`trigger` text NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_run_events_run_idx` ON `workflow_run_events` (`workflow_run_id`,`id`);--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `result_json` text;