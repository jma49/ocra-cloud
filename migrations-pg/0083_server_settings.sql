CREATE TABLE "server_settings" (
	"name" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"sealed" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
