CREATE TABLE `workflow_transition_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`record_kind` text NOT NULL,
	`record_id` integer NOT NULL,
	`record_json` text NOT NULL,
	`summary_changed` integer,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_transition_changes_record_unique` ON `workflow_transition_changes` (`run_id`,`revision`,`record_kind`,`record_id`);--> statement-breakpoint
CREATE INDEX `workflow_transition_changes_revision_idx` ON `workflow_transition_changes` (`run_id`,`revision`);--> statement-breakpoint
CREATE INDEX `workflow_transition_changes_record_idx` ON `workflow_transition_changes` (`run_id`,`record_kind`,`record_id`,`revision`);