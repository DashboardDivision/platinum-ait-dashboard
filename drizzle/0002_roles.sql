CREATE TABLE "role_permission" (
	"role" text PRIMARY KEY NOT NULL,
	"perms" jsonb NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "phone_e164" text;