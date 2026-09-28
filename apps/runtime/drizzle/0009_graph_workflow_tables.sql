CREATE TABLE `workflow_artifacts` (
	`hash` text PRIMARY KEY NOT NULL,
	`workflow_key` text NOT NULL,
	`sdk_version` text NOT NULL,
	`verifier_version` text NOT NULL,
	`contract_version` integer NOT NULL,
	`structure_json` text NOT NULL,
	`first_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_artifacts_key_idx` ON `workflow_artifacts` (`workflow_key`);--> statement-breakpoint
CREATE TABLE `workflow_checkpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`execution_id` integer NOT NULL,
	`title` text NOT NULL,
	`commit_sha` text,
	`scopes_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_checkpoints_run_idx` ON `workflow_checkpoints` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_checkpoints_execution_idx` ON `workflow_checkpoints` (`execution_id`);--> statement-breakpoint
CREATE TABLE `workflow_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`execution_id` integer,
	`at` text NOT NULL,
	`category` text NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`data_json` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_events_run_idx` ON `workflow_events` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `workflow_executions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`invocation_id` integer NOT NULL,
	`node_id` text NOT NULL,
	`node_kind` text NOT NULL,
	`visit_index` integer NOT NULL,
	`label` text,
	`artifact_hash` text NOT NULL,
	`status` text NOT NULL,
	`retry_of` integer,
	`result_json` text,
	`event_json` text,
	`decision_json` text,
	`state_after_json` text,
	`child_invocation_id` integer,
	`checkpoint_id` integer,
	`error_json` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invocation_id`) REFERENCES `workflow_graph_invocations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_hash`) REFERENCES `workflow_artifacts`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_executions_run_idx` ON `workflow_executions` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_executions_invocation_idx` ON `workflow_executions` (`invocation_id`,`id`);--> statement-breakpoint
CREATE TABLE `workflow_graph_invocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`parent_execution_id` integer,
	`graph_key` text NOT NULL,
	`depth` integer NOT NULL,
	`label` text,
	`parameters_json` text NOT NULL,
	`state_json` text NOT NULL,
	`status` text NOT NULL,
	`outcome_json` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_graph_invocations_run_idx` ON `workflow_graph_invocations` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `workflow_operations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`execution_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`agent_session_id` integer,
	`pane_id` integer,
	`harness` text,
	`model` text,
	`effort` text,
	`request_json` text NOT NULL,
	`status` text NOT NULL,
	`response_text` text,
	`result_json` text,
	`harness_session_id` text,
	`usage_json` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_operations_run_idx` ON `workflow_operations` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_operations_execution_idx` ON `workflow_operations` (`execution_id`,`seq`);--> statement-breakpoint
CREATE INDEX `workflow_operations_agent_session_idx` ON `workflow_operations` (`agent_session_id`,`id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`workflow_key` text NOT NULL,
	`title` text NOT NULL,
	`artifact_hash` text NOT NULL,
	`status` text NOT NULL,
	`inputs_json` text NOT NULL,
	`placement_json` text NOT NULL,
	`origin_worktree_id` integer NOT NULL,
	`origin_worktree_path` text NOT NULL,
	`origin_surface_id` integer,
	`origin_pane_id` integer,
	`origin_agent_session_id` integer,
	`worktree_id` integer,
	`worktree_path` text,
	`setup_done` integer DEFAULT false NOT NULL,
	`surface_id` integer,
	`error_json` text,
	`outcome_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`artifact_hash`) REFERENCES `workflow_artifacts`(`hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`surface_id`) REFERENCES `worktree_surfaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_project_idx` ON `workflow_runs` (`project_id`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_status_idx` ON `workflow_runs` (`status`);--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow_key_idx` ON `workflow_runs` (`workflow_key`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_surface_idx` ON `workflow_runs` (`surface_id`);