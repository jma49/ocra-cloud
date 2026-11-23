ALTER TABLE "webhook_deliveries" RENAME TO "notify_deliveries";--> statement-breakpoint
ALTER TABLE "notify_deliveries" DROP CONSTRAINT "webhook_deliveries_account_id_accounts_id_fk";
--> statement-breakpoint
DROP INDEX "webhook_deliveries_channel_created";--> statement-breakpoint
DROP INDEX "webhook_deliveries_account_created";--> statement-breakpoint
DROP INDEX "webhook_deliveries_retry";--> statement-breakpoint
ALTER TABLE "notify_deliveries" ADD CONSTRAINT "notify_deliveries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notify_deliveries_channel_created" ON "notify_deliveries" USING btree ("account_id","channel_id","created_at");--> statement-breakpoint
CREATE INDEX "notify_deliveries_account_created" ON "notify_deliveries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "notify_deliveries_retry" ON "notify_deliveries" USING btree ("retry_at");