import "dotenv/config";

function csv(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/**
 * Central runtime configuration. Credentials are read from the environment only —
 * never hard-coded in source.
 */
export const config = {
  port: Number(process.env.PORT ?? 8000),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:5432/template_module",
  autoMigrate: bool(process.env.AUTO_MIGRATE, true),
  corsOrigins: csv(process.env.CORS_ORIGINS, "http://localhost:5173"),
  ollama: {
    baseUrl:
      process.env.OLLAMA_BASE_URL ??
      process.env.OLLAMA_HOST ??
      "http://127.0.0.1:11434",
    model: process.env.OLLAMA_MODEL ?? "llama3",
    temperature: Number(process.env.OLLAMA_TEMPERATURE ?? "0"),
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? "90000"),
  },
  rules: {
    maxSteps: Number(process.env.MAX_STEPS ?? "20"),
    supportedRoles: csv(
      process.env.SUPPORTED_ROLES,
      "officer,approver,coordinator",
    ),
    supportedNotificationChannels: csv(
      process.env.SUPPORTED_NOTIFICATION_CHANNELS,
      "email,telegram",
    ),
  },
};

export type AppConfig = typeof config;
