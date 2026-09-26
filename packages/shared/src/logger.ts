import { pino } from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Không bao giờ log credential
  redact: {
    paths: [
      "req.headers.authorization",
      "*.apiKey",
      "*.api_key",
      "*.password",
      "*.secret",
    ],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
