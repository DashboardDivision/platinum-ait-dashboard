CREATE TYPE "public"."agent_program" AS ENUM('free_agent', 'group_sell');--> statement-breakpoint
CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program" "agent_program" NOT NULL,
	"twenty_workspace_id" text NOT NULL,
	"twenty_object" text NOT NULL,
	"twenty_record_id" text NOT NULL,
	"user_id" text,
	"full_name" text NOT NULL,
	"organization" text,
	"email" text NOT NULL,
	"phone_e164" text,
	"recruiter" text,
	"status" text DEFAULT 'active' NOT NULL,
	"welcome_status" text DEFAULT 'not_sent' NOT NULL,
	"invited_at" timestamp with time zone,
	"invited_by_user_id" text,
	"first_login_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "agent_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by_user_id" text,
	"note" text,
	CONSTRAINT "agent_step_range" CHECK ("agent_step"."step" between 1 and 6)
);
--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_step" ADD CONSTRAINT "agent_step_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_twenty_identity_uq" ON "agent" USING btree ("twenty_workspace_id","twenty_object","twenty_record_id");--> statement-breakpoint
CREATE INDEX "agent_program_idx" ON "agent" USING btree ("program","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_step_once_uq" ON "agent_step" USING btree ("agent_id","step");