import type { Logger } from "pino";
import nodemailer from "nodemailer";

export type OtpDeliveryResult =
  | { ok: true; via: "smtp" | "twilio" | "msg91" | "mock" }
  | { ok: false; error: string; details?: Record<string, unknown> };

export type OtpDeliveryErrorKind = "config" | "provider";

export class OtpDeliveryError extends Error {
  kind: OtpDeliveryErrorKind;
  httpStatus: 500 | 503;
  details?: Record<string, unknown>;

  constructor(message: string, opts: { kind: OtpDeliveryErrorKind; httpStatus: 500 | 503; details?: Record<string, unknown> }) {
    super(message);
    this.name = "OtpDeliveryError";
    this.kind = opts.kind;
    this.httpStatus = opts.httpStatus;
    this.details = opts.details;
  }
}

export function isProductionEnv(): boolean {
  // Treat Render as production-like even if NODE_ENV isn't set correctly.
  return process.env.NODE_ENV === "production" || !!process.env.RENDER;
}

function maskEmail(email: string): string {
  const [u, d] = email.split("@");
  if (!d) return "***";
  const safe = u.length <= 2 ? "*" : `${u.slice(0, 2)}…`;
  return `${safe}@${d}`;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `…${digits.slice(-4)}`;
}

function missingEnv(keys: string[]): Record<string, boolean> {
  return Object.fromEntries(keys.map((k) => [k, !process.env[k]]));
}

export async function sendEmailOtp(log: Logger, to: string, code: string): Promise<OtpDeliveryResult> {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = process.env.SMTP_PORT;
  const from = process.env.SMTP_FROM ?? process.env.MAIL_FROM ?? user;

  if (!host || !user || !pass) {
    const missing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"].filter((k) => !process.env[k]);
    if (isProductionEnv()) {
      throw new OtpDeliveryError("OTP email delivery is not configured (missing SMTP environment variables).", {
        kind: "config",
        httpStatus: 500,
        details: { missing },
      });
    }
    log.warn(
      { channel: "email", missingEnv: missingEnv(["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]), to: maskEmail(to) },
      "OTP email: SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS)",
    );
    return { ok: false, error: "smtp_not_configured", details: { missing } };
  }

  if (!from) {
    log.warn({ channel: "email" }, "OTP email: set SMTP_FROM or MAIL_FROM for a valid From header");
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port: port ? Number(port) : 587,
      secure: process.env.SMTP_SECURE === "true",
      auth: { user, pass },
    });
    await transporter.sendMail({
      from: from ?? user,
      to,
      subject: process.env.OTP_EMAIL_SUBJECT ?? "Your Khabar verification code",
      text: `Your Khabar verification code is ${code}. It expires in 10 minutes.`,
    });
    log.info({ channel: "email", to: maskEmail(to) }, "OTP email sent via SMTP");
    return { ok: true, via: "smtp" };
  } catch (err) {
    log.error(
      {
        err,
        channel: "email",
        to: maskEmail(to),
        smtpHost: host,
        smtpPort: port ?? "587",
      },
      "OTP email: nodemailer send failed (check SMTP_*, network, firewall)",
    );
    if (isProductionEnv()) {
      throw new OtpDeliveryError("OTP email delivery failed (SMTP provider unavailable).", {
        kind: "provider",
        httpStatus: 503,
        details: { message: err instanceof Error ? err.message : String(err) },
      });
    }
    return {
      ok: false,
      error: "smtp_send_failed",
      details: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function sendSmsTwilio(log: Logger, to: string, code: string): Promise<OtpDeliveryResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER ?? process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    const missing = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"].filter(
      (k) => !process.env[k] && !(k === "TWILIO_PHONE_NUMBER" && process.env.TWILIO_FROM_NUMBER),
    );
    if (isProductionEnv()) {
      throw new OtpDeliveryError("OTP SMS delivery is not configured (missing Twilio environment variables).", {
        kind: "config",
        httpStatus: 500,
        details: { missing },
      });
    }
    log.warn(
      {
        channel: "phone",
        missingEnv: missingEnv(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"]),
        to: maskPhone(to),
      },
      "OTP SMS: Twilio not fully configured",
    );
    return { ok: false, error: "twilio_not_configured", details: { missing } };
  }

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const body = new URLSearchParams({
      To: to,
      From: from,
      Body: `Your Khabar verification code is ${code}. It expires in 10 minutes.`,
    });
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const text = await resp.text();
    if (!resp.ok) {
      log.error(
        {
          channel: "phone",
          to: maskPhone(to),
          status: resp.status,
          twilioBody: text.slice(0, 800),
        },
        "OTP SMS: Twilio API returned an error",
      );
      if (isProductionEnv()) {
        throw new OtpDeliveryError("OTP SMS delivery failed (Twilio API error).", {
          kind: "provider",
          httpStatus: 503,
          details: { status: resp.status },
        });
      }
      return { ok: false, error: "twilio_api_error", details: { status: resp.status } };
    }
    log.info({ channel: "phone", to: maskPhone(to) }, "OTP SMS sent via Twilio");
    return { ok: true, via: "twilio" };
  } catch (err) {
    log.error({ err, channel: "phone", to: maskPhone(to) }, "OTP SMS: Twilio request failed");
    if (isProductionEnv()) {
      throw new OtpDeliveryError("OTP SMS delivery failed (Twilio provider unavailable).", {
        kind: "provider",
        httpStatus: 503,
        details: { message: err instanceof Error ? err.message : String(err) },
      });
    }
    return {
      ok: false,
      error: "twilio_request_failed",
      details: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function sendSmsMsg91(log: Logger, to: string, code: string): Promise<OtpDeliveryResult> {
  const authkey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  const senderId = process.env.MSG91_SENDER_ID;

  if (!authkey || !templateId || !senderId) {
    const missing = ["MSG91_AUTH_KEY", "MSG91_TEMPLATE_ID", "MSG91_SENDER_ID"].filter((k) => !process.env[k]);
    if (isProductionEnv()) {
      throw new OtpDeliveryError("OTP SMS delivery is not configured (missing MSG91 environment variables).", {
        kind: "config",
        httpStatus: 500,
        details: { missing },
      });
    }
    log.warn(
      {
        channel: "phone",
        missingEnv: missingEnv(["MSG91_AUTH_KEY", "MSG91_TEMPLATE_ID", "MSG91_SENDER_ID"]),
        to: maskPhone(to),
      },
      "OTP SMS: MSG91 not fully configured",
    );
    return { ok: false, error: "msg91_not_configured", details: { missing } };
  }

  const mobile = to.replace(/\D/g, "");
  if (!mobile) {
    log.error({ channel: "phone", raw: to }, "OTP SMS: could not normalize phone for MSG91");
    if (isProductionEnv()) {
      throw new OtpDeliveryError("OTP SMS delivery failed (invalid phone number).", {
        kind: "provider",
        httpStatus: 500,
        details: { raw: to },
      });
    }
    return { ok: false, error: "invalid_phone" };
  }

  try {
    const url = "https://control.msg91.com/api/v5/flow/";
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authkey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        template_id: templateId,
        short_url: "0",
        recipients: [
          {
            mobiles: mobile,
            [process.env.MSG91_OTP_FIELD ?? "otp"]: code,
          },
        ],
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      log.error(
        {
          channel: "phone",
          to: maskPhone(to),
          status: resp.status,
          msg91Body: text.slice(0, 800),
        },
        "OTP SMS: MSG91 flow API returned an error (verify template_id and recipient field names)",
      );
      if (isProductionEnv()) {
        throw new OtpDeliveryError("OTP SMS delivery failed (MSG91 API error).", {
          kind: "provider",
          httpStatus: 503,
          details: { status: resp.status },
        });
      }
      return { ok: false, error: "msg91_api_error", details: { status: resp.status } };
    }
    log.info({ channel: "phone", to: maskPhone(to) }, "OTP SMS sent via MSG91");
    return { ok: true, via: "msg91" };
  } catch (err) {
    log.error({ err, channel: "phone", to: maskPhone(to) }, "OTP SMS: MSG91 request failed");
    if (isProductionEnv()) {
      throw new OtpDeliveryError("OTP SMS delivery failed (MSG91 provider unavailable).", {
        kind: "provider",
        httpStatus: 503,
        details: { message: err instanceof Error ? err.message : String(err) },
      });
    }
    return {
      ok: false,
      error: "msg91_request_failed",
      details: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export async function sendPhoneOtp(log: Logger, to: string, code: string): Promise<OtpDeliveryResult> {
  const hasTwilio = !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    (process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER)
  );
  const hasMsg91 = !!(
    process.env.MSG91_AUTH_KEY &&
    process.env.MSG91_TEMPLATE_ID &&
    process.env.MSG91_SENDER_ID
  );

  if (hasTwilio) {
    const twilioResult = await sendSmsTwilio(log, to, code);
    if (twilioResult.ok) return twilioResult;
    if (hasMsg91) {
      log.warn({ errCode: twilioResult.error }, "OTP SMS: Twilio failed; retrying with MSG91");
      return sendSmsMsg91(log, to, code);
    }
    return twilioResult;
  }

  if (hasMsg91) {
    return sendSmsMsg91(log, to, code);
  }

  if (isProductionEnv()) {
    throw new OtpDeliveryError("OTP SMS delivery is not configured (no provider configured).", {
      kind: "config",
      httpStatus: 500,
      details: {
        missingProviders: true,
        hint:
          "Set Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER) or MSG91 (MSG91_AUTH_KEY, MSG91_TEMPLATE_ID, MSG91_SENDER_ID)",
      },
    });
  }
  log.warn(
    {
      channel: "phone",
      to: maskPhone(to),
      hint: "Set Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER) or MSG91 (MSG91_AUTH_KEY, MSG91_TEMPLATE_ID, MSG91_SENDER_ID)",
    },
    "OTP SMS: no provider configured",
  );
  return { ok: false, error: "sms_not_configured" };
}
