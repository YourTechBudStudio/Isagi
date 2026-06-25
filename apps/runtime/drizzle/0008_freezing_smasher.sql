ALTER TABLE `workflow_runs` ADD `paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `cancel_requested` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `workflow_runs_paused_idx` ON `workflow_runs` (`paused`);