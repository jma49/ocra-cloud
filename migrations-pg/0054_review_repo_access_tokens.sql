ALTER TABLE "review_repos" ADD COLUMN "access_token_wrapped_key" text;--> statement-breakpoint
ALTER TABLE "review_repos" ADD COLUMN "access_token_ciphertext" text;--> statement-breakpoint
ALTER TABLE "review_repos" ADD COLUMN "access_token_bot" text;