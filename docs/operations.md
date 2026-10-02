# Using and running the dashboard

## Admins
- **Recruits:** every enrollment with stage, days in stage, premium and what needs attention. Filters can be saved as views. Export CSV is formula-safe.
- **Attention queue:** account setup problems, help requests, documents and policies to review, failed messages.
- **Recruit page:** timeline, proof review, contract, policies, reimbursement and payouts, accounts (reset link or one-time temporary password), notes, tasks and the audit trail. "Login as AIT" needs your password again and lasts 30 minutes; it can't complete stages, sign, or change passwords or payments.
- **Settings:** exam link, help contact, policy types, inactivity reminder days, texts on/off, your email alerts.

## Recruits
Sign in with their email and phone number, choose a new password, then follow the next step shown: study, schedule the exam, upload results, sign the contract, start training, and track production to $250,000.

## Configuration checklist
- [ ] `app.env` filled in; `PROVISION_FROM` set to go-live
- [ ] Colton's admin account created and password changed
- [ ] Twenty API key and webhook created
- [ ] n8n credentials and workflows installed and active
- [ ] Gmail app password moved to the server and the PC copy deleted
- [ ] Backup cron installed and one restore tested on the demo
- [ ] Adobe Acrobat Sign API plan confirmed (until then, contracts use admin-reviewed upload)
- [ ] Approved AIT contract added
- [ ] Momentum AMP read-only key issued, field mapping checked, workflow activated
- [ ] Platinum Telnyx key and 10DLC campaign approved before texts are turned on
- [ ] Existing Twenty records: run the backfill preview, get Colton's OK, then apply

## Backfill of records that existed before launch
In n8n, open "Platinum AIT - Backfill (manual, preview first)" and run it. Review the preview. To enroll, change the Options node to `"mode": "apply"` (and `"sendWelcome": true` if welcomes should go out), run it once, then set it back to preview.
