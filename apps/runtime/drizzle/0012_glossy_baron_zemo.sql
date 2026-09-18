CREATE TABLE `runtime_identity` (
	`id` integer PRIMARY KEY NOT NULL,
	`runtime_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_identity_runtime_id_unique` ON `runtime_identity` (`runtime_id`);--> statement-breakpoint
CREATE TABLE `workflow_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evidence_key` text NOT NULL,
	`run_id` integer NOT NULL,
	`frame_id` integer NOT NULL,
	`execution_id` integer NOT NULL,
	`attempt_id` integer NOT NULL,
	`operation_id` integer NOT NULL,
	`artifact_hash` text NOT NULL,
	`title` text NOT NULL,
	`role` text NOT NULL,
	`labels_json` text NOT NULL,
	`content_kind` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`content_ref` text NOT NULL,
	`source_path` text,
	`source_kind` text NOT NULL,
	`source_agent_session_id` integer,
	`source_operation_id` integer,
	`source_attribution` text NOT NULL,
	`captured_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`frame_id`) REFERENCES `workflow_graph_frames`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_node_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`) REFERENCES `workflow_segment_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_id`) REFERENCES `workflow_operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_hash`) REFERENCES `workflow_artifacts`(`artifact_hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_operation_id`) REFERENCES `workflow_operations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_evidence_key_unique` ON `workflow_evidence` (`evidence_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_evidence_operation_unique` ON `workflow_evidence` (`operation_id`);--> statement-breakpoint
CREATE INDEX `workflow_evidence_run_idx` ON `workflow_evidence` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_evidence_execution_idx` ON `workflow_evidence` (`execution_id`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_evidence_run_role_idx` ON `workflow_evidence` (`run_id`,`role`);--> statement-breakpoint
CREATE INDEX `workflow_evidence_source_operation_idx` ON `workflow_evidence` (`source_operation_id`);--> statement-breakpoint
ALTER TABLE `workflow_operations` ADD `harness` text;--> statement-breakpoint
ALTER TABLE `workflow_operations` ADD `model` text;--> statement-breakpoint
ALTER TABLE `workflow_operations` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `workflow_operations` ADD `cwd` text;--> statement-breakpoint
ALTER TABLE `workflow_operations` ADD `runtime_id` text;--> statement-breakpoint
ALTER TABLE `workflow_operations` ADD `incarnation_id` text;--> statement-breakpoint
ALTER TABLE `workflow_operations` ADD `usage_json` text;