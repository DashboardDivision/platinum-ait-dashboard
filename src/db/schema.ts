import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date());

/* ---------------------------------------------------------------- auth (Better Auth) */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  // Never set true just because the address came from Twenty or got a welcome email.
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("recruit"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: ts("ban_expires"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("session_user_idx").on(t.userId)]);

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("account_user_idx").on(t.userId)]);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("verification_identifier_idx").on(t.identifier)]);

export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

/* ---------------------------------------------------------------- recruits */

export const recruitStatus = pgEnum("recruit_status", ["active", "archived", "withdrawn"]);
export const stage5Substatus = pgEnum("stage5_substatus", ["awaiting_contract", "in_training"]);

export const recruit = pgTable("recruit", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").unique().references(() => user.id, { onDelete: "set null" }),
  // Immutable CRM identity. Editable contact values live in their own columns.
  twentyWorkspaceId: text("twenty_workspace_id").notNull(),
  twentyObject: text("twenty_object").notNull().default("platinumAit"),
  twentyRecordId: text("twenty_record_id").notNull(),
  fullName: text("full_name").notNull(),
  email: text("email"),
  phoneE164: text("phone_e164"),
  contactIssue: text("contact_issue"),
  status: recruitStatus("status").notNull().default("active"),
  cohort: text("cohort"),
  source: text("source"),
  ownerAdminId: text("owner_admin_id").references(() => user.id, { onDelete: "set null" }),
  homeState: text("home_state"),
  momentumProducerId: text("momentum_producer_id"),
  enrollmentAt: ts("enrollment_at").notNull(),
  enrollmentAtBasis: text("enrollment_at_basis").notNull(), // twenty_record_created | manual | import_fallback
  enrollmentEndedAt: ts("enrollment_ended_at"),
  accountCreatedAt: ts("account_created_at"),
  firstLoginAt: ts("first_login_at"),
  initialPasswordChangedAt: ts("initial_password_changed_at"),
  lastActivityAt: ts("last_activity_at"),
  // Education site is left unmodified (2026-10-02): these stay null and the UI says "Unavailable".
  educationAccountCreatedAt: ts("education_account_created_at"),
  educationFirstLoginAt: ts("education_first_login_at"),
  educationInitialPasswordChangedAt: ts("education_initial_password_changed_at"),
  firstStudyClickAt: ts("first_study_click_at"),
  readyToScheduleAt: ts("ready_to_schedule_at"),
  examLinkClickedAt: ts("exam_link_clicked_at"),
  examDate: date("exam_date"),
  examBookingConfirmation: text("exam_booking_confirmation"),
  examPassedAt: ts("exam_passed_at"),
  licenseIssuedAt: ts("license_issued_at"),
  licenseNumber: text("license_number"),
  licenseState: text("license_state"),
  stage5Substatus: stage5Substatus("stage5_substatus"),
  contractSignedAt: ts("contract_signed_at"),
  trainingStartedAt: ts("training_started_at"),
  graduatedAt: ts("graduated_at"),
  welcomeStatus: text("welcome_status").notNull().default("not_sent"), // not_sent | queued | sent | failed
  premiumBelowThreshold: text("premium_below_threshold"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("recruit_twenty_identity_uq").on(t.twentyWorkspaceId, t.twentyObject, t.twentyRecordId),
  index("recruit_status_idx").on(t.status),
  index("recruit_email_idx").on(t.email),
]);

export const stageInterval = pgTable("stage_interval", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitId: uuid("recruit_id").notNull().references(() => recruit.id, { onDelete: "cascade" }),
  stage: integer("stage").notNull(),
  enteredAt: ts("entered_at").notNull(),
  completedAt: ts("completed_at"),
  evidence: jsonb("evidence").$type<Record<string, unknown>>(),
  reopenReason: text("reopen_reason"),
  actorUserId: text("actor_user_id"),
}, (t) => [
  index("stage_interval_recruit_idx").on(t.recruitId),
  // At most one open interval per recruit.
  uniqueIndex("stage_interval_one_open_uq").on(t.recruitId).where(sql`${t.completedAt} is null`),
  check("stage_range", sql`${t.stage} between 1 and 5`),
]);

/** Recruit-visible activity. Admin/impersonated/service actions are stored with actorKind != 'recruit' and never count. */
export const activityEvent = pgTable("activity_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitId: uuid("recruit_id").notNull().references(() => recruit.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // login | password_changed | study_link_click | ready_to_schedule | exam_link_click | proof_uploaded | ...
  actorKind: text("actor_kind").notNull(), // recruit | admin | impersonation | service
  actorUserId: text("actor_user_id"),
  impersonatorUserId: text("impersonator_user_id"),
  at: ts("at").notNull().defaultNow(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
}, (t) => [index("activity_recruit_at_idx").on(t.recruitId, t.at)]);

/* ---------------------------------------------------------------- provisioning */

export const provisioningSystem = pgEnum("provisioning_system", ["dashboard", "education"]);
export const provisioningStatus = pgEnum("provisioning_status", ["pending", "ready", "missing_information", "needs_match_review", "failed", "unavailable"]);

export const provisioning = pgTable("provisioning", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitId: uuid("recruit_id").notNull().references(() => recruit.id, { onDelete: "cascade" }),
  system: provisioningSystem("system").notNull(),
  status: provisioningStatus("status").notNull().default("pending"),
  externalAccountId: text("external_account_id"),
  linkedExisting: boolean("linked_existing").notNull().default(false),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  lastAttemptAt: ts("last_attempt_at"),
  readyAt: ts("ready_at"),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("provisioning_recruit_system_uq").on(t.recruitId, t.system)]);

/** Inbound integration events (Twenty webhooks, Momentum syncs, signing callbacks). Deduped by source + event id. */
export const inboundEvent = pgTable("inbound_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(),
  eventId: text("event_id").notNull(),
  sourceTime: ts("source_time"),
  receivedAt: ts("received_at").notNull().defaultNow(),
  status: text("status").notNull().default("received"),
  detail: text("detail"),
}, (t) => [uniqueIndex("inbound_event_uq").on(t.source, t.eventId)]);

/* ---------------------------------------------------------------- documents, exams, contracts */

export const documentKind = pgEnum("document_kind", ["exam_result", "license", "receipt", "contract_signed", "contract_external"]);
export const documentStatus = pgEnum("document_status", ["uploaded", "approved", "needs_replacement", "quarantined"]);

export const document = pgTable("document", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitId: uuid("recruit_id").notNull().references(() => recruit.id, { onDelete: "cascade" }),
  kind: documentKind("kind").notNull(),
  status: documentStatus("status").notNull().default("uploaded"),
  storageKey: text("storage_key").notNull().unique(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  state: text("state"),
  examDate: date("exam_date"),
  licenseNumber: text("license_number"),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  uploadedByUserId: text("uploaded_by_user_id"),
  uploadedAt: ts("uploaded_at").notNull().defaultNow(),
  reviewedByUserId: text("reviewed_by_user_id"),
  reviewedAt: ts("reviewed_at"),
  reviewReason: text("review_reason"),
}, (t) => [index("document_recruit_idx").on(t.recruitId)]);

export const contractTemplate = pgTable("contract_template", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: text("version").notNull().unique(),
  name: text("name").notNull(),
  providerTemplateId: text("provider_template_id"),
  sourceDocumentKey: text("source_document_key"),
  active: boolean("active").notNull().default(false),
  createdAt: createdAt(),
});

export const contractInstance = pgTable("contract_instance", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitId: uuid("recruit_id").notNull().references(() => recruit.id, { onDelete: "cascade" }),
  templateId: uuid("template_id").references(() => contractTemplate.id),
  source: text("source").notNull(), // adobe_sign | external_upload
  providerRef: text("provider_ref"),
  status: text("status").notNull().default("draft"), // draft | sent | viewed | signed | declined | cancelled | uploaded_pending_review | verified_upload
  sentAt: ts("sent_at"),
  lastReminderAt: ts("last_reminder_at"),
  signedAt: ts("signed_at"),
  signedDocumentId: uuid("signed_document_id").references(() => document.id),
  auditEvidence: jsonb("audit_evidence").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("contract_recruit_idx").on(t.recruitId), uniqueIndex("contract_provider_ref_uq").on(t.providerRef)]);

/* ---------------------------------------------------------------- production */

export const policy = pgTable("policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitId: uuid("recruit_id").notNull().references(() => recruit.id, { onDelete: "cascade" }),
  source: text("source").notNull(), // momentum | admin | recruit | csv
  externalRef: text("external_ref").notNull(), // policy number or source id; unique per source
  policyType: text("policy_type").notNull(),
  carrier: text("carrier"),
  businessType: text("business_type").notNull().default("new"), // new | renewal | rewrite | endorsement | quote
  writtenDate: date("written_date", { mode: "date" }).notNull(),
  effectiveDate: date("effective_date", { mode: "date" }),
  termMonths: integer("term_months"),
  termPremiumCents: bigint("term_premium_cents", { mode: "number" }),
  annualizedCents: bigint("annualized_cents", { mode: "number" }).notNull(),
  annualizedSource: text("annualized_source").notNull(), // authoritative | calculated
  status: text("status").notNull().default("pending"), // pending | approved | rejected | cancelled | duplicate
  countsOverride: boolean("counts_override"),
  reviewedByUserId: text("reviewed_by_user_id"),
  reviewedAt: ts("reviewed_at"),
  reviewReason: text("review_reason"),
  submittedByUserId: text("submitted_by_user_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("policy_source_ref_uq").on(t.source, t.externalRef), index("policy_recruit_idx").on(t.recruitId)]);

export const policyAdjustment = pgTable("policy_adjustment", {
  id: uuid("id").primaryKey().defaultRandom(),
  policyId: uuid("policy_id").notNull().references(() => policy.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // cancellation | reversal | correction
  deltaCents: bigint("delta_cents", { mode: "number" }).notNull(),
  reason: text("reason").notNull(),
  externalRef: text("external_ref"),
  actorUserId: text("actor_user_id"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [uniqueIndex("policy_adjustment_ext_uq").on(t.policyId, t.externalRef)]);

export const milestoneAchievement = pgTable("milestone_achievement", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitId: uuid("recruit_id").notNull().references(() => recruit.id, { onDelete: "cascade" }),
  milestone: text("milestone").notNull(),
  achievedAt: ts("achieved_at").notNull(),
  premiumCentsAtAchievement: bigint("premium_cents_at_achievement", { mode: "number" }).notNull(),
  correctedByUserId: text("corrected_by_user_id"),
  correctionReason: text("correction_reason"),
}, (t) => [uniqueIndex("milestone_once_uq").on(t.recruitId, t.milestone)]);

/* ---------------------------------------------------------------- payouts & reimbursements */

export const payout = pgTable("payout", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitId: uuid("recruit_id").notNull().references(() => recruit.id, { onDelete: "cascade" }),
  payoutType: text("payout_type").notNull(),
  periodLabel: text("period_label"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  basis: text("basis"),
  policyIds: jsonb("policy_ids").$type<string[]>(),
  status: text("status").notNull().default("pending"), // pending | approved | paid | reversed
  approvedByUserId: text("approved_by_user_id"),
  paidAt: ts("paid_at"),
  paymentRef: text("payment_ref"),
  reversesPayoutId: uuid("reverses_payout_id"),
  createdAt: createdAt(),
}, (t) => [index("payout_recruit_idx").on(t.recruitId)]);

export const reimbursement = pgTable("reimbursement", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitId: uuid("recruit_id").notNull().references(() => recruit.id, { onDelete: "cascade" }),
  // Exactly one case per approved exam-pass event.
  examProofDocumentId: uuid("exam_proof_document_id").notNull().unique().references(() => document.id),
  status: text("status").notNull().default("awaiting_receipt"), // awaiting_receipt | submitted | approved | partially_paid | paid | rejected
  testCostCents: bigint("test_cost_cents", { mode: "number" }),
  requestedCents: bigint("requested_cents", { mode: "number" }),
  approvedCents: bigint("approved_cents", { mode: "number" }),
  receiptDocumentId: uuid("receipt_document_id").references(() => document.id),
  reviewerUserId: text("reviewer_user_id"),
  taskId: uuid("task_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const reimbursementPayment = pgTable("reimbursement_payment", {
  id: uuid("id").primaryKey().defaultRandom(),
  reimbursementId: uuid("reimbursement_id").notNull().references(() => reimbursement.id, { onDelete: "cascade" }),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(), // negative = compensating adjustment
  paidAt: ts("paid_at").notNull(),
  paymentRef: text("payment_ref").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  note: text("note"),
}, (t) => [uniqueIndex("reimbursement_payment_ref_uq").on(t.reimbursementId, t.paymentRef)]);

/* ---------------------------------------------------------------- tasks, notes, messaging, audit, config */

export const task = pgTable("task", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitId: uuid("recruit_id").references(() => recruit.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // stage4_followup | help_request | provisioning | contact_fix | general
  title: text("title").notNull(),
  body: text("body"),
  ownerUserId: text("owner_user_id"),
  status: text("status").notNull().default("open"), // open | done
  dedupeKey: text("dedupe_key").unique(),
  dueAt: ts("due_at"),
  completedAt: ts("completed_at"),
  completedByUserId: text("completed_by_user_id"),
  createdAt: createdAt(),
}, (t) => [index("task_status_idx").on(t.status)]);

export const note = pgTable("note", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitId: uuid("recruit_id").notNull().references(() => recruit.id, { onDelete: "cascade" }),
  authorUserId: text("author_user_id").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const consent = pgTable("consent", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitId: uuid("recruit_id").notNull().references(() => recruit.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(), // sms
  granted: boolean("granted").notNull(),
  source: text("source").notNull(),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("consent_recruit_idx").on(t.recruitId, t.channel, t.at)]);

export const alertPreference = pgTable("alert_preference", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  channel: text("channel").notNull(),
  enabled: boolean("enabled").notNull(),
}, (t) => [uniqueIndex("alert_pref_pk").on(t.userId, t.eventType, t.channel)]);

/** Transactional outbox. Payloads never contain passwords, tokens or documents. */
export const outbox = pgTable("outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventType: text("event_type").notNull(),
  recruitId: uuid("recruit_id").references(() => recruit.id, { onDelete: "set null" }),
  dedupeKey: text("dedupe_key").notNull().unique(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("pending"), // pending | claimed | done | failed
  attempts: integer("attempts").notNull().default(0),
  availableAt: ts("available_at").notNull().defaultNow(),
  claimedAt: ts("claimed_at"),
  lastError: text("last_error"),
  createdAt: createdAt(),
}, (t) => [index("outbox_pending_idx").on(t.status, t.availableAt)]);

export const messageDelivery = pgTable("message_delivery", {
  id: uuid("id").primaryKey().defaultRandom(),
  outboxId: uuid("outbox_id").references(() => outbox.id, { onDelete: "set null" }),
  recruitId: uuid("recruit_id").references(() => recruit.id, { onDelete: "set null" }),
  purpose: text("purpose").notNull(),
  recipient: text("recipient").notNull(),
  channel: text("channel").notNull(), // email | sms
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status").notNull(), // queued | sent | delivered | bounced | failed | suppressed
  providerRef: text("provider_ref"),
  detail: text("detail"),
  updatedAt: updatedAt(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("delivery_once_uq").on(t.dedupeKey, t.recipient, t.channel)]);

export const auditEvent = pgTable("audit_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: text("actor_user_id"),
  impersonatorUserId: text("impersonator_user_id"),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  reason: text("reason"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  ip: text("ip"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("audit_target_idx").on(t.targetType, t.targetId), index("audit_at_idx").on(t.at)]);

export const setting = pgTable("setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedByUserId: text("updated_by_user_id"),
  updatedAt: updatedAt(),
});

export const savedView = pgTable("saved_view", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  query: text("query").notNull(),
  createdAt: createdAt(),
});
