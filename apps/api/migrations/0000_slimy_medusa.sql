CREATE TABLE `opencode_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`root_path` text NOT NULL,
	`base_url` text NOT NULL,
	`port` integer NOT NULL,
	`pid` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opencode_instances_root_path_idx` ON `opencode_instances` (`root_path`);--> statement-breakpoint
CREATE TABLE `opencode_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`opencode_instance_id` text NOT NULL,
	`opencode_session_id` text NOT NULL,
	`agent` text NOT NULL,
	`status_type` text DEFAULT 'idle' NOT NULL,
	`is_waiting_on_user` integer DEFAULT false NOT NULL,
	`last_message_role` text,
	`status_updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`opencode_instance_id`) REFERENCES `opencode_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opencode_sessions_opencode_session_id_idx` ON `opencode_sessions` (`opencode_session_id`);--> statement-breakpoint
CREATE INDEX `opencode_sessions_agent_idx` ON `opencode_sessions` (`agent`);--> statement-breakpoint
CREATE INDEX `opencode_sessions_waiting_idx` ON `opencode_sessions` (`is_waiting_on_user`);--> statement-breakpoint
CREATE TABLE `spark_triage` (
	`id` text PRIMARY KEY NOT NULL,
	`spark_id` text NOT NULL,
	`opencode_session_id` text NOT NULL,
	`triage_path` text NOT NULL,
	`last_validation_error` text,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`spark_id`) REFERENCES `sparks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spark_triage_spark_id_idx` ON `spark_triage` (`spark_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `spark_triage_opencode_session_id_idx` ON `spark_triage` (`opencode_session_id`);--> statement-breakpoint
CREATE INDEX `spark_triage_closed_at_idx` ON `spark_triage` (`closed_at`);--> statement-breakpoint
CREATE TABLE `sparks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`path` text NOT NULL,
	`original_path` text,
	`working_path` text,
	`triage_path` text,
	`created_at` integer NOT NULL
);
