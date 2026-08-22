CREATE TABLE `replay_events` (
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`created_at` integer NOT NULL,
	`turn` integer NOT NULL,
	`phase` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`run_id`, `sequence`)
);
--> statement-breakpoint
CREATE TABLE `replay_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`maze_seed` text NOT NULL,
	`maze_json` text NOT NULL,
	`initial_position_json` text NOT NULL
);
