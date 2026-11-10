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
 * A usable TCP port. dotenv never overrides a variable that is already set, so a
 * stray `PORT=0` in the surrounding shell would otherwise make the API bind a
 * random port while the web app keeps calling :8000.
 */
function port(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

/**
 * Central runtime configuration. Credentials are read from the environment only —
 * never hard-coded in source.
 */
export const config = {
  port: port(process.env.PORT, 8000),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:5432/template_module",
  autoMigrate: bool(process.env.AUTO_MIGRATE, true),
  /** Where `document` steps write their generated files. */
  documentOutputDir:
    process.env.DOCUMENT_OUTPUT_DIR ?? "output/documents",
  corsOrigins: csv(process.env.CORS_ORIGINS, "http://localhost:5173"),
  ollama: {
    baseUrl:
      process.env.OLLAMA_BASE_URL ??
      process.env.OLLAMA_HOST ??
      "http://127.0.0.1:11434",
    model: process.env.OLLAMA_MODEL ?? "qwen3.5:9b",
    temperature: Number(process.env.OLLAMA_TEMPERATURE ?? "0.1"),
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
