ALTER TABLE `workflow_runs` ADD `workflow_title` text NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `parent_run_id` integer REFERENCES workflow_runs(id);--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `root_run_id` integer REFERENCES workflow_runs(id);--> statement-breakpoint
CREATE INDEX `workflow_runs_root_idx` ON `workflow_runs` (`root_run_id`);