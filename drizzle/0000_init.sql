CREATE TYPE "public"."document_kind" AS ENUM('exam_result', 'license', 'receipt', 'contract_signed', 'contract_external');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('uploaded', 'approved', 'needs_replacement', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."provisioning_status" AS ENUM('pending', 'ready', 'missing_information', 'needs_match_review', 'failed', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."provisioning_system" AS ENUM('dashboard', 'education');--> statement-breakpoint
CREATE TYPE "public"."recruit_status" AS ENUM('active', 'archived', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."stage5_substatus" AS ENUM('awaiting_contract', 'in_training');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"impersonator_user_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "alert_preference" (
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text,
	"impersonator_user_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"reason" text,
	"metadata" jsonb,
	"ip" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"granted" boolean NOT NULL,
	"source" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_instance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"template_id" uuid,
	"source" text NOT NULL,
	"provider_ref" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	"last_reminder_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signed_document_id" uuid,
	"audit_evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"name" text NOT NULL,
	"provider_template_id" text,
	"source_document_key" text,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_template_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"kind" "document_kind" NOT NULL,
	"status" "document_status" DEFAULT 'uploaded' NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"state" text,
	"exam_date" date,
	"license_number" text,
	"meta" jsonb,
	"uploaded_by_user_id" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"review_reason" text,
	CONSTRAINT "document_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "inbound_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"source_time" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "message_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_id" uuid,
	"recruit_id" uuid,
	"purpose" text NOT NULL,
	"recipient" text NOT NULL,
	"channel" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text NOT NULL,
	"provider_ref" text,
	"detail" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestone_achievement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"milestone" text NOT NULL,
	"achieved_at" timestamp with time zone NOT NULL,
	"premium_cents_at_achievement" bigint NOT NULL,
	"corrected_by_user_id" text,
	"correction_reason" text
);
--> statement-breakpoint
CREATE TABLE "note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"recruit_id" uuid,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "payout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"payout_type" text NOT NULL,
	"period_label" text,
	"amount_cents" bigint NOT NULL,
	"basis" text,
	"policy_ids" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by_user_id" text,
	"paid_at" timestamp with time zone,
	"payment_ref" text,
	"reverses_payout_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_ref" text NOT NULL,
	"policy_type" text NOT NULL,
	"carrier" text,
	"business_type" text DEFAULT 'new' NOT NULL,
	"written_date" date NOT NULL,
	"effective_date" date,
	"term_months" integer,
	"term_premium_cents" bigint,
	"annualized_cents" bigint NOT NULL,
	"annualized_source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"counts_override" boolean,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"review_reason" text,
	"submitted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"delta_cents" bigint NOT NULL,
	"reason" text NOT NULL,
	"external_ref" text,
	"actor_user_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisioning" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"system" "provisioning_system" NOT NULL,
	"status" "provisioning_status" DEFAULT 'pending' NOT NULL,
	"external_account_id" text,
	"linked_existing" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "recruit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"twenty_workspace_id" text NOT NULL,
	"twenty_object" text DEFAULT 'platinumAit' NOT NULL,
	"twenty_record_id" text NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"phone_e164" text,
	"contact_issue" text,
	"status" "recruit_status" DEFAULT 'active' NOT NULL,
	"cohort" text,
	"source" text,
	"owner_admin_id" text,
	"home_state" text,
	"momentum_producer_id" text,
	"enrollment_at" timestamp with time zone NOT NULL,
	"enrollment_at_basis" text NOT NULL,
	"enrollment_ended_at" timestamp with time zone,
	"account_created_at" timestamp with time zone,
	"first_login_at" timestamp with time zone,
	"initial_password_changed_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"education_account_created_at" timestamp with time zone,
	"education_first_login_at" timestamp with time zone,
	"education_initial_password_changed_at" timestamp with time zone,
	"first_study_click_at" timestamp with time zone,
	"ready_to_schedule_at" timestamp with time zone,
	"exam_link_clicked_at" timestamp with time zone,
	"exam_date" date,
	"exam_booking_confirmation" text,
	"exam_passed_at" timestamp with time zone,
	"license_issued_at" timestamp with time zone,
	"license_number" text,
	"license_state" text,
	"stage5_substatus" "stage5_substatus",
	"contract_signed_at" timestamp with time zone,
	"training_started_at" timestamp with time zone,
	"graduated_at" timestamp with time zone,
	"welcome_status" text DEFAULT 'not_sent' NOT NULL,
	"premium_below_threshold" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recruit_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "reimbursement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"exam_proof_document_id" uuid NOT NULL,
	"status" text DEFAULT 'awaiting_receipt' NOT NULL,
	"test_cost_cents" bigint,
	"requested_cents" bigint,
	"approved_cents" bigint,
	"receipt_document_id" uuid,
	"reviewer_user_id" text,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reimbursement_exam_proof_document_id_unique" UNIQUE("exam_proof_document_id")
);
--> statement-breakpoint
CREATE TABLE "reimbursement_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reimbursement_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"payment_ref" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "saved_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_interval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid NOT NULL,
	"stage" integer NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"evidence" jsonb,
	"reopen_reason" text,
	"actor_user_id" text,
	CONSTRAINT "stage_range" CHECK ("stage_interval"."stage" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruit_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"owner_user_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"dedupe_key" text,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'recruit' NOT NULL,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_preference" ADD CONSTRAINT "alert_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instance" ADD CONSTRAINT "contract_instance_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instance" ADD CONSTRAINT "contract_instance_template_id_contract_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."contract_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_instance" ADD CONSTRAINT "contract_instance_signed_document_id_document_id_fk" FOREIGN KEY ("signed_document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_delivery" ADD CONSTRAINT "message_delivery_outbox_id_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_delivery" ADD CONSTRAINT "message_delivery_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_achievement" ADD CONSTRAINT "milestone_achievement_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_adjustment" ADD CONSTRAINT "policy_adjustment_policy_id_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning" ADD CONSTRAINT "provisioning_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruit" ADD CONSTRAINT "recruit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruit" ADD CONSTRAINT "recruit_owner_admin_id_user_id_fk" FOREIGN KEY ("owner_admin_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement" ADD CONSTRAINT "reimbursement_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement" ADD CONSTRAINT "reimbursement_exam_proof_document_id_document_id_fk" FOREIGN KEY ("exam_proof_document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement" ADD CONSTRAINT "reimbursement_receipt_document_id_document_id_fk" FOREIGN KEY ("receipt_document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement_payment" ADD CONSTRAINT "reimbursement_payment_reimbursement_id_reimbursement_id_fk" FOREIGN KEY ("reimbursement_id") REFERENCES "public"."reimbursement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_interval" ADD CONSTRAINT "stage_interval_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_recruit_id_recruit_id_fk" FOREIGN KEY ("recruit_id") REFERENCES "public"."recruit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "activity_recruit_at_idx" ON "activity_event" USING btree ("recruit_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_pref_pk" ON "alert_preference" USING btree ("user_id","event_type","channel");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_event" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_event" USING btree ("at");--> statement-breakpoint
CREATE INDEX "consent_recruit_idx" ON "consent" USING btree ("recruit_id","channel","at");--> statement-breakpoint
CREATE INDEX "contract_recruit_idx" ON "contract_instance" USING btree ("recruit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_provider_ref_uq" ON "contract_instance" USING btree ("provider_ref");--> statement-breakpoint
CREATE INDEX "document_recruit_idx" ON "document" USING btree ("recruit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_event_uq" ON "inbound_event" USING btree ("source","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_once_uq" ON "message_delivery" USING btree ("dedupe_key","recipient","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "milestone_once_uq" ON "milestone_achievement" USING btree ("recruit_id","milestone");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "payout_recruit_idx" ON "payout" USING btree ("recruit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_source_ref_uq" ON "policy" USING btree ("source","external_ref");--> statement-breakpoint
CREATE INDEX "policy_recruit_idx" ON "policy" USING btree ("recruit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_adjustment_ext_uq" ON "policy_adjustment" USING btree ("policy_id","external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_recruit_system_uq" ON "provisioning" USING btree ("recruit_id","system");--> statement-breakpoint
CREATE UNIQUE INDEX "recruit_twenty_identity_uq" ON "recruit" USING btree ("twenty_workspace_id","twenty_object","twenty_record_id");--> statement-breakpoint
CREATE INDEX "recruit_status_idx" ON "recruit" USING btree ("status");--> statement-breakpoint
CREATE INDEX "recruit_email_idx" ON "recruit" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "reimbursement_payment_ref_uq" ON "reimbursement_payment" USING btree ("reimbursement_id","payment_ref");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stage_interval_recruit_idx" ON "stage_interval" USING btree ("recruit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_interval_one_open_uq" ON "stage_interval" USING btree ("recruit_id") WHERE "stage_interval"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "task_status_idx" ON "task" USING btree ("status");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");