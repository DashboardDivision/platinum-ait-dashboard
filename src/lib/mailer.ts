import nodemailer from "nodemailer";
import { env } from "./env";

/**
 * Only security mail (password recovery, admin-forced reset notices) goes out
 * from the app directly, so reset links never land in n8n execution history.
 * Everything else goes through the outbox and n8n.
 */
export async function sendSecurityEmail(to: string, subject: string, text: string): Promise<"sent" | "not_configured"> {
  const e = env();
  if (!e.SMTP_HOST || !e.SMTP_USER || !e.SMTP_PASSWORD) {
    if (e.APP_ENV !== "production") console.info(`[mail:not-configured] to=${to} subject=${subject}`);
    return "not_configured";
  }
  const transport = nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT ?? 465,
    secure: (e.SMTP_PORT ?? 465) === 465,
    auth: { user: e.SMTP_USER, pass: e.SMTP_PASSWORD },
    logger: false,
  });
  await transport.sendMail({ from: e.MAIL_FROM, to, subject, text });
  return "sent";
}
