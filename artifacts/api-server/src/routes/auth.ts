import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "crypto";
import { eq, or } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { OAuth2Client } from "google-auth-library";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import {
  RegisterBody,
  LoginBody,
  LoginResponse,
  LogoutResponse,
  GetCurrentUserResponse,
  UpdateCurrentUserBody,
  UpdateCurrentUserResponse,
  CheckAvailabilityQueryParams,
  CheckAvailabilityResponse,
} from "@workspace/api-zod";
import {
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  type AuthedRequest,
} from "../lib/auth";
import { getUserCounts, serializeCurrentUser } from "../lib/serializers";
import { OtpDeliveryError, isProductionEnv, sendEmailOtp, sendPhoneOtp } from "../lib/otpDelivery";

const router: IRouter = Router();

const registerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

function newUid(): string {
  return `u_${randomBytes(8).toString("hex")}`;
}

type OtpChannel = "email" | "phone";
type StoredOtp = { code: string; expiresAtMs: number };
const otpStore = new Map<string, Partial<Record<OtpChannel, StoredOtp>>>();

function generateOtp(): string {
  // 6-digit OTP
  const n = Math.floor(100000 + Math.random() * 900000);
  return String(n);
}

function otpKey(uid: string): string {
  return uid;
}

function getWebBaseUrl(): string {
  // In production we serve the web app from the same Express host, so prefer relative redirects.
  // If you deploy the frontend on a separate domain, set CLIENT_URL (or WEB_BASE_URL) explicitly.
  const raw = (process.env.CLIENT_URL ?? process.env.WEB_BASE_URL ?? "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

function getGoogleOAuthClient(): { client: OAuth2Client; redirectUri: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { client: new OAuth2Client({ clientId, clientSecret, redirectUri }), redirectUri };
}

async function findAvailableUsername(base: string): Promise<string> {
  const normalizedBase = base.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const candidateBase = normalizedBase || "user";

  const [match] = await db
    .select({ uid: usersTable.uid })
    .from(usersTable)
    .where(eq(usersTable.username, candidateBase));
  if (!match) return candidateBase;

  // Try a few suffixes, then fall back to random.
  for (let i = 2; i <= 50; i++) {
    const candidate = `${candidateBase}${i}`;
    const [m] = await db
      .select({ uid: usersTable.uid })
      .from(usersTable)
      .where(eq(usersTable.username, candidate));
    if (!m) return candidate;
  }
  return `${candidateBase}_${randomBytes(3).toString("hex")}`;
}

async function startGoogleOAuth(req: Request, res: Response): Promise<void> {
  const oauth = getGoogleOAuthClient();
  if (!oauth) {
    req.log.warn(
      {
        missingEnv: {
          GOOGLE_CLIENT_ID: !process.env.GOOGLE_CLIENT_ID,
          GOOGLE_CLIENT_SECRET: !process.env.GOOGLE_CLIENT_SECRET,
          GOOGLE_REDIRECT_URI: !process.env.GOOGLE_REDIRECT_URI,
        },
      },
      "Google OAuth start requested but credentials are not configured",
    );
    res.status(501).json({
      error:
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
    });
    return;
  }

  const next = typeof req.query.next === "string" ? req.query.next : "/";
  const state = Buffer.from(JSON.stringify({ next }), "utf8").toString("base64url");

  const url = oauth.client.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    prompt: "consent",
    state,
  });

  res.redirect(url);
}

/** Canonical entry for SPA links; same behavior as `/auth/google/start`. */
router.get("/auth/google", startGoogleOAuth);
router.get("/auth/google/start", startGoogleOAuth);

router.get("/auth/google/callback", async (req, res): Promise<void> => {
  const oauth = getGoogleOAuthClient();
  if (!oauth) {
    res.status(501).json({
      error:
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
    });
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const rawState = typeof req.query.state === "string" ? req.query.state : "";
  const next =
    (() => {
      try {
        const parsed = JSON.parse(Buffer.from(rawState, "base64url").toString("utf8")) as { next?: string };
        return parsed.next || "/";
      } catch {
        return "/";
      }
    })();

  if (!code) {
    res.redirect(`${getWebBaseUrl()}/login?next=${encodeURIComponent(next)}&error=google_oauth_failed`);
    return;
  }

  try {
    const tokenResp = await oauth.client.getToken(code);
    const idToken = tokenResp.tokens.id_token;
    if (!idToken) {
      res.redirect(`${getWebBaseUrl()}/login?next=${encodeURIComponent(next)}&error=google_oauth_failed`);
      return;
    }

    const ticket = await oauth.client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const googleId = payload?.sub;
    const email = payload?.email?.toLowerCase().trim();
    const displayName = (payload?.name ?? "").trim();
    const photoUrl = (payload?.picture ?? "").trim();

    if (!googleId || !email) {
      res.redirect(`${getWebBaseUrl()}/login?next=${encodeURIComponent(next)}&error=google_oauth_failed`);
      return;
    }

    // Upsert: prefer existing googleId, otherwise match by email.
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(or(eq(usersTable.googleId, googleId), eq(usersTable.email, email)));

    let user = existing;
    if (existing) {
      const updates: Partial<typeof usersTable.$inferInsert> = {};
      if (!existing.googleId) updates.googleId = googleId;
      if (!existing.isEmailVerified) updates.isEmailVerified = true;
      if (!existing.photoUrl && photoUrl) updates.photoUrl = photoUrl;
      if (!existing.displayName && displayName) updates.displayName = displayName;

      if (Object.keys(updates).length > 0) {
        const [updated] = await db
          .update(usersTable)
          .set(updates)
          .where(eq(usersTable.uid, existing.uid))
          .returning();
        if (updated) user = updated;
      }
    } else {
      const uid = newUid();
      const base = email.split("@")[0] ?? "user";
      const username = await findAvailableUsername(base);
      const passwordHash = await hashPassword(randomBytes(32).toString("hex"));

      const [created] = await db
        .insert(usersTable)
        .values({
          uid,
          username,
          email,
          passwordHash,
          displayName: displayName || username,
          state: "Unknown",
          district: "Unknown",
          locality: "Unknown",
          phoneNumber: null,
          photoUrl: photoUrl || null,
          currentReputationScore: 0,
          isEmailVerified: true,
          isPhoneVerified: false,
          googleId,
        })
        .returning();
      user = created;
    }

    if (!user) {
      res.redirect(`${getWebBaseUrl()}/login?next=${encodeURIComponent(next)}&error=google_oauth_failed`);
      return;
    }

    const token = signToken(user.uid);
    setAuthCookie(res, token);

    // Always redirect to same-origin path by default.
    const safeNext = next.startsWith("/") ? next : `/${next}`;
    res.redirect(`${getWebBaseUrl()}${safeNext}`);
  } catch (err) {
    req.log.warn({ err }, "Google OAuth callback failed");
    res.redirect(`${getWebBaseUrl()}/login?next=${encodeURIComponent(next)}&error=google_oauth_failed`);
  }
});

router.post("/auth/verify/request", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const channel = (req.body?.channel as OtpChannel | undefined) ?? "email";
  if (channel !== "email" && channel !== "phone") {
    res.status(400).json({ error: "Invalid channel" });
    return;
  }

  const user = req.user!;
  if (channel === "phone" && !user.phoneNumber) {
    res.status(400).json({ error: "No phone number on file" });
    return;
  }

  const code = generateOtp();
  const expiresAtMs = Date.now() + 10 * 60 * 1000;
  const key = otpKey(user.uid);
  const existing = otpStore.get(key) ?? {};
  otpStore.set(key, { ...existing, [channel]: { code, expiresAtMs } });

  const isProd = isProductionEnv();

  try {
    if (channel === "email") {
      const delivered = await sendEmailOtp(req.log, user.email, code);
      if (!delivered.ok) {
        if (!isProd && delivered.error === "smtp_not_configured") {
          // Dev-only convenience: allow local testing without SMTP.
          console.log(`[OTP] uid=${user.uid} channel=${channel} otp=${code}`);
        } else {
          res.status(503).json({ error: "Failed to send OTP. Please contact support." });
          return;
        }
      }
    } else {
      const phone = user.phoneNumber!;
      const delivered = await sendPhoneOtp(req.log, phone, code);
      if (!delivered.ok) {
        if (!isProd && delivered.error === "sms_not_configured") {
          // Dev-only convenience: allow local testing without SMS provider.
          console.log(`[OTP] uid=${user.uid} channel=${channel} otp=${code}`);
        } else {
          res.status(503).json({ error: "Failed to send OTP. Please contact support." });
          return;
        }
      }
    }
  } catch (err) {
    if (err instanceof OtpDeliveryError) {
      // In production this is our strict behavior: no mock fallback, and never leak OTP.
      req.log.error({ err, uid: user.uid, channel }, "OTP delivery failed");
      res.status(err.httpStatus).json({ error: "Failed to send OTP. Please contact support." });
      return;
    }
    req.log.error({ err, uid: user.uid, channel }, "Unexpected error while sending OTP");
    res.status(500).json({ error: "Failed to send OTP. Please contact support." });
    return;
  }

  res.json({ ok: true, channel, expiresInSeconds: 600 });
});

router.post("/auth/verify/confirm", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const channel = (req.body?.channel as OtpChannel | undefined) ?? "email";
  const code = String(req.body?.code ?? "").trim();
  if (channel !== "email" && channel !== "phone") {
    res.status(400).json({ error: "Invalid channel" });
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "Invalid OTP" });
    return;
  }

  const user = req.user!;
  if (channel === "phone" && !user.phoneNumber) {
    res.status(400).json({ error: "No phone number on file" });
    return;
  }

  const key = otpKey(user.uid);
  const record = otpStore.get(key)?.[channel];
  if (!record) {
    res.status(400).json({ error: "No OTP requested" });
    return;
  }
  if (Date.now() > record.expiresAtMs) {
    res.status(400).json({ error: "OTP expired" });
    return;
  }
  if (record.code !== code) {
    res.status(400).json({ error: "Incorrect OTP" });
    return;
  }

  const updates: Partial<typeof usersTable.$inferInsert> =
    channel === "email"
      ? { isEmailVerified: true }
      : { isPhoneVerified: true };

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.uid, user.uid))
    .returning();

  const nextStore = { ...(otpStore.get(key) ?? {}) };
  delete nextStore[channel];
  otpStore.set(key, nextStore);

  const counts = await getUserCounts((updated ?? user).uid);
  res.json(GetCurrentUserResponse.parse(serializeCurrentUser(updated ?? user, counts)));
});

function ensureCloudinaryConfigured(): { ok: true } | { ok: false; error: string } {
  if (process.env.CLOUDINARY_URL) {
    cloudinary.config({ secure: true });
    return { ok: true };
  }
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (cloudName && apiKey && apiSecret) {
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
    return { ok: true };
  }
  const missing = [
    !process.env.CLOUDINARY_URL ? "CLOUDINARY_URL" : null,
    !cloudName ? "CLOUDINARY_CLOUD_NAME" : null,
    !apiKey ? "CLOUDINARY_API_KEY" : null,
    !apiSecret ? "CLOUDINARY_API_SECRET" : null,
  ].filter(Boolean);
  return {
    ok: false,
    error:
      `Cloudinary is not configured. Set CLOUDINARY_URL (recommended) or ` +
      `CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET. Missing: ${missing.join(", ")}`,
  };
}

async function uploadAvatarToCloudinary(
  file: Express.Multer.File,
): Promise<{ secureUrl: string }> {
  const ct = (file.mimetype ?? "").toLowerCase();
  const ok = ["image/jpeg", "image/png", "image/webp"].includes(ct);
  if (!ok) {
    throw new Error(`Unsupported photo type: ${file.mimetype}`);
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error("Photo exceeds 10MB");
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "khabar/avatars",
        resource_type: "image",
        unique_filename: true,
      },
      (err, result) => {
        if (err || !result?.secure_url) {
          reject(err ?? new Error("Upload failed"));
          return;
        }
        resolve({ secureUrl: result.secure_url });
      },
    );
    stream.end(file.buffer);
  });
}

router.post("/auth/register", registerUpload.single("photo"), async (req, res): Promise<void> => {
  // `multer` populates text fields on req.body for multipart requests.
  const parsed = RegisterBody.safeParse({
    username: req.body?.username,
    email: req.body?.email,
    password: req.body?.password,
    displayName: req.body?.displayName,
    state: req.body?.state,
    district: req.body?.district,
    locality: req.body?.locality,
    phoneNumber: req.body?.phoneNumber,
    photoUrl: undefined,
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const data = parsed.data;
  const username = data.username.trim().toLowerCase();
  const email = data.email.trim().toLowerCase();

  if (!/^[a-z0-9_]+$/i.test(username)) {
    res.status(400).json({
      error: "Username may only contain letters, numbers, and underscores",
    });
    return;
  }

  const existing = await db
    .select({ uid: usersTable.uid, username: usersTable.username, email: usersTable.email })
    .from(usersTable)
    .where(or(eq(usersTable.username, username), eq(usersTable.email, email)));
  for (const row of existing) {
    if (row.username === username) {
      res.status(409).json({ error: "That username is already taken" });
      return;
    }
    if (row.email === email) {
      res.status(409).json({ error: "An account with that email already exists" });
      return;
    }
  }

  let photoUrl: string | null = null;
  const file = req.file;
  if (file) {
    const cfg = ensureCloudinaryConfigured();
    if (!cfg.ok) {
      req.log.error({ configured: false }, "Cloudinary is not configured for avatar upload");
      res.status(isProductionEnv() ? 500 : 501).json({ error: cfg.error });
      return;
    }
    try {
      const uploaded = await uploadAvatarToCloudinary(file);
      photoUrl = uploaded.secureUrl;
    } catch (err) {
      req.log.error({ err }, "Avatar upload failed during registration");
      res.status(500).json({ error: "Failed to upload avatar" });
      return;
    }
  }

  const passwordHash = await hashPassword(data.password);
  const uid = newUid();
  const [created] = await db
    .insert(usersTable)
    .values({
      uid,
      username,
      email,
      passwordHash,
      displayName: data.displayName.trim(),
      state: data.state.trim() || "Unknown",
      district: data.district.trim() || "Unknown",
      locality: data.locality.trim() || "Unknown",
      phoneNumber: data.phoneNumber?.trim() || null,
      photoUrl,
      currentReputationScore: 0,
      isEmailVerified: false,
      isPhoneVerified: false,
      googleId: null,
    })
    .returning();

  if (!created) {
    res.status(500).json({ error: "Failed to create user" });
    return;
  }

  const token = signToken(created.uid);
  setAuthCookie(res, token);

  const counts = await getUserCounts(created.uid);
  res.status(201).json(GetCurrentUserResponse.parse(serializeCurrentUser(created, counts)));
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const ok = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const token = signToken(user.uid);
  setAuthCookie(res, token);
  const counts = await getUserCounts(user.uid);
  res.json(LoginResponse.parse(serializeCurrentUser(user, counts)));
});

router.post("/auth/logout", async (_req, res: Response): Promise<void> => {
  clearAuthCookie(res);
  res.json(LogoutResponse.parse({ ok: true }));
});

router.get("/auth/me", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const user = req.user!;
  const counts = await getUserCounts(user.uid);
  res.json(GetCurrentUserResponse.parse(serializeCurrentUser(user, counts)));
});

router.patch("/auth/me", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const parsed = UpdateCurrentUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (parsed.data.displayName != null && parsed.data.displayName.trim() !== "") {
    updates.displayName = parsed.data.displayName.trim();
  }
  if (parsed.data.state != null && parsed.data.state.trim() !== "") {
    updates.state = parsed.data.state.trim();
  }
  if (parsed.data.district != null && parsed.data.district.trim() !== "") {
    updates.district = parsed.data.district.trim();
  }
  if (parsed.data.locality != null && parsed.data.locality.trim() !== "") {
    updates.locality = parsed.data.locality.trim();
  }
  if (parsed.data.phoneNumber !== undefined) {
    const trimmed = parsed.data.phoneNumber?.trim() ?? "";
    updates.phoneNumber = trimmed === "" ? null : trimmed;
  }
  if (parsed.data.photoUrl !== undefined) {
    const trimmed = parsed.data.photoUrl?.trim() ?? "";
    updates.photoUrl = trimmed === "" ? null : trimmed;
  }

  let user = req.user!;
  if (Object.keys(updates).length > 0) {
    const [updated] = await db
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.uid, user.uid))
      .returning();
    if (updated) user = updated;
  }
  const counts = await getUserCounts(user.uid);
  res.json(UpdateCurrentUserResponse.parse(serializeCurrentUser(user, counts)));
});

router.get("/auth/check-availability", async (req, res): Promise<void> => {
  const parsed = CheckAvailabilityQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }
  const out: { usernameAvailable?: boolean; emailAvailable?: boolean } = {};
  if (parsed.data.username) {
    const username = parsed.data.username.trim().toLowerCase();
    const [match] = await db
      .select({ uid: usersTable.uid })
      .from(usersTable)
      .where(eq(usersTable.username, username));
    out.usernameAvailable = !match;
  }
  if (parsed.data.email) {
    const email = parsed.data.email.trim().toLowerCase();
    const [match] = await db
      .select({ uid: usersTable.uid })
      .from(usersTable)
      .where(eq(usersTable.email, email));
    out.emailAvailable = !match;
  }
  res.json(CheckAvailabilityResponse.parse(out));
});

export default router;
