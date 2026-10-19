CREATE TABLE "meeting_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"month" text NOT NULL,
	"meeting_key" text NOT NULL,
	"attended" boolean NOT NULL,
	"marked_by_user_id" text,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_attendance_month_fmt" CHECK ("meeting_attendance"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "meeting_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"month" text NOT NULL,
	"meeting_key" text NOT NULL,
	"join_url" text,
	"starts_at" timestamp with time zone,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_session_month_fmt" CHECK ("meeting_session"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "training_module_completion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_module_completion" ADD CONSTRAINT "training_module_completion_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_attendance_once_uq" ON "meeting_attendance" USING btree ("recruit_id","month","meeting_key");--> statement-breakpoint
CREATE INDEX "meeting_attendance_month_idx" ON "meeting_attendance" USING btree ("month");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_session_month_uq" ON "meeting_session" USING btree ("month","meeting_key");--> statement-breakpoint
CREATE UNIQUE INDEX "training_module_once_uq" ON "training_module_completion" USING btree ("recruit_id","module_key");