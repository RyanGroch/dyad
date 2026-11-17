ALTER TABLE `supabase_self_hosted_instances` ADD `ssh_host` text;--> statement-breakpoint
ALTER TABLE `supabase_self_hosted_instances` ADD `ssh_port` integer;--> statement-breakpoint
ALTER TABLE `supabase_self_hosted_instances` ADD `ssh_username` text;--> statement-breakpoint
ALTER TABLE `supabase_self_hosted_instances` ADD `ssh_private_key_encrypted` text;--> statement-breakpoint
ALTER TABLE `supabase_self_hosted_instances` ADD `ssh_host_key_fingerprint` text;--> statement-breakpoint
ALTER TABLE `supabase_self_hosted_instances` ADD `functions_container` text;