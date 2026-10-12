import * as z from "zod";
import { config } from "../config";

const errorBody = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
});

export type Mail = { to: string; subject: string; text: string };

/** What would have been sent, when no provider is configured outside production (dev logs it, tests read it). */
export const outbox: Mail[] = [];

/**
 * Sends one transactional email through Resend (plain `fetch`, no SDK). Never throws: a mail provider that is
 * down must not break signing up or asking for a reset, so a failure is only logged (without the body, which
 * carries a single-use link).
 */
export async function sendMail(mail: Mail): Promise<void> {
  if (!config.RESEND_API_KEY || !config.MAIL_FROM) {
    if (config.NODE_ENV === "production") {
      console.error(
        JSON.stringify({ level: "warn", event: "mail_not_configured" }),
      );
      return;
    }
    outbox.push(mail);
    if (outbox.length > 50) outbox.shift();
    if (config.NODE_ENV === "development") {
      console.log(`\n[mail] to ${mail.to}: ${mail.subject}\n${mail.text}\n`);
    }
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.MAIL_FROM,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Resend's error says what to fix (bad sender, unverified domain...); it never echoes the email body.
      const error = errorBody.safeParse(await res.json().catch(() => null));
      const reason = error.success
        ? [error.data.name, error.data.message].filter(Boolean).join(": ")
        : "";
      throw new Error(`Resend answered ${res.status} ${reason}`.trim());
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "mail_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
