import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    // Common sensitive body fields (in case any route logs parsed bodies)
    "req.body.password",
    "req.body.token",
    "req.body.idToken",
    "req.body.refreshToken",
    "req.body.code",
    "req.body.otp",
    "req.body.smsCode",
    "req.body.email",
    "req.body.phone",
    "req.body.phoneNumber",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
