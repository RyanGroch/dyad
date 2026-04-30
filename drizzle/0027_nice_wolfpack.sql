CREATE TABLE `message_pieces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`piece_index` integer NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`attributes_json` text,
	`byte_start` integer NOT NULL,
	`byte_end` integer NOT NULL,
	`est_height_px` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_pieces_msg_idx_unique` ON `message_pieces` (`message_id`,`piece_index`);