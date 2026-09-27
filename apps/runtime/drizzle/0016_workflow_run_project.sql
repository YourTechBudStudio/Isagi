ALTER TABLE `workflow_runs` ADD `project_id` integer NOT NULL;--> statement-breakpoint
CREATE INDEX `workflow_runs_project_idx` ON `workflow_runs` (`project_id`,`id`);