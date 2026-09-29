ALTER TABLE `workflow_checkpoints` ADD `label` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `parameters_json` text NOT NULL;