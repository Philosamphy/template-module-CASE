import { OllamaTemplateGenerator } from "./ai/generator.js";
import { PostgresAuditLog } from "./audit/auditLog.js";
import { OllamaDocumentContentGenerator } from "./ai/documentContent.js";
import { OllamaFileReader } from "./ai/fileReader.js";
import { PostgresOperatorDirectory } from "./auth/operators.js";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { createPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { SimulatedNotificationPort } from "./execution/notifier.js";
import { HtmlFileDocumentGenerator } from "./execution/documents.js";
import { PostgresExecutionRepository } from "./repo/pgExecutionRepo.js";
import { PostgresTemplateRepository } from "./repo/pgRepo.js";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

async function main(): Promise<void> {
  const pool = createPool(config.databaseUrl);

  pool.on("error", (error) => {
    console.error("[postgres] idle client error:", error.message);
  });

  if (config.autoMigrate) {
    const applied = await migrate(pool);
    if (applied.length > 0) {
      console.log(`[migrations] applied: ${applied.join(", ")}`);
    }
  }

  // LangGraph checkpoint tables (paused workflows survive restarts).
  const checkpointer = PostgresSaver.fromConnString(config.databaseUrl);
  await checkpointer.setup();

  const app = createApp({
    repo: new PostgresTemplateRepository(pool),
    executions: new PostgresExecutionRepository(pool),
    checkpointer,
    notifier: new SimulatedNotificationPort(),
    documents: new HtmlFileDocumentGenerator(
      config.documentOutputDir,
      // AI drafts the document body during execution (CASE document-designer
      // prompt); on any model failure the port falls back to input rendering.
      new OllamaDocumentContentGenerator({
        baseUrl: config.ollama.baseUrl,
        model: config.ollama.model,
        temperature: config.ollama.temperature,
        timeoutMs: config.ollama.timeoutMs,
      }),
    ),
    operators: new PostgresOperatorDirectory(pool),
    generator: new OllamaTemplateGenerator({
      baseUrl: config.ollama.baseUrl,
      model: config.ollama.model,
      temperature: config.ollama.temperature,
      timeoutMs: config.ollama.timeoutMs,
      supportedRoles: config.rules.supportedRoles,
    }),
    rules: config.rules,
    corsOrigins: config.corsOrigins,
    documentOutputDir: config.documentOutputDir,
    audit: new PostgresAuditLog(pool),
    files: new OllamaFileReader({
      baseUrl: config.ollama.baseUrl,
      model: config.ollama.model,
      temperature: config.ollama.temperature,
      timeoutMs: config.ollama.timeoutMs,
    }),
  });

  app.listen(config.port, () => {
    console.log(`Template API listening on http://127.0.0.1:${config.port}`);
    console.log(`  Ollama: ${config.ollama.baseUrl} (${config.ollama.model})`);
  });
}

main().catch((error: unknown) => {
  console.error(
    "[startup] failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
