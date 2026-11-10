import { promises as fs } from "node:fs";
import path from "node:path";
import type { WorkflowStep } from "../domain/schemas.js";
import type { DocumentContent } from "../ai/documentContent.js";

export interface DocumentRequest {
  instanceId: string;
  templateName: string;
  step: WorkflowStep;
  /** Case data the instance was started with — the document is built from it. */
  input: Record<string, string>;
}

export interface GeneratedDocument {
  /** Path written on disk (relative to the server working directory by default). */
  file: string;
  bytes: number;
  /**
   * Whether the body came from the AI content draft (`ai`) or the plain
   * rendering of the case input (`input`, including every failure fallback).
   */
  contentSource?: "ai" | "input";
  /** The AI-drafted document title, when one was produced. */
  title?: string;
}

/**
 * Input to the content drafter: everything the model needs to write the
 * document body. The port itself never touches the network or the disk.
 */
export interface DocumentContentRequest {
  templateName: string;
  stepName: string;
  stepDescription: string;
  input: Record<string, string>;
}

/**
 * Outbound content port: drafts the *content* of a document (as structured
 * title/sections/table data, per the CASE platform's document schemas). The
 * execution layer only depends on this interface; the Ollama implementation
 * lives in `ai/documentContent.ts`, and tests use a fixed double.
 */
export interface DocumentContentPort {
  draft(request: DocumentContentRequest): Promise<DocumentContent>;
}

/**
 * Outbound document port. A `document` step produces a real file during
 * execution; nothing is sent anywhere — the artifact stays on disk and its
 * path is recorded in `step_runs.result`.
 *
 * Swap this implementation for a PDF/DOCX renderer without touching the
 * execution graph.
 */
export interface DocumentPort {
  generate(request: DocumentRequest): Promise<GeneratedDocument>;
}

/** No-op double for tests that do not exercise document steps. */
export class NullDocumentPort implements DocumentPort {
  async generate(): Promise<GeneratedDocument> {
    return { file: "", bytes: 0 };
  }
}

/**
 * Escapes the five HTML metacharacters. Entities are built from char codes so
 * the source itself never needs to contain them (& etc).
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** Keeps step ids from escaping the output directory (ids are validated, this is defence in depth). */
function safeFileName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^\.+/, "");
  return cleaned || "step";
}

const STYLES = `
    body { font-family: Georgia, serif; margin: 3rem auto; max-width: 46rem; color: #1e293b; }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    h2 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
    .subtitle { color: #475569; font-size: 1rem; margin-bottom: 0.25rem; }
    .meta { color: #64748b; font-size: 0.85rem; margin-bottom: 1.5rem; }
    .body { white-space: pre-wrap; line-height: 1.6; margin-bottom: 0.75rem; }
    .section-label { color: #64748b; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
    th { width: 30%; background: #f8fafc; font-weight: 600; }
    table.data th, table.data td { width: auto; }
    table.data thead th { border-bottom: 2px solid #cbd5e1; }`;

/** The case-data table (key/value rows), shared by both render modes. */
function inputTableHtml(input: Record<string, string>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return `    <table><tbody><tr><td colspan="2">No input data was provided for this instance.</td></tr></tbody></table>`;
  }
  const rows = entries
    .map(
      ([key, value]) =>
        `      <tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`,
    )
    .join("\n");
  return `    <table><tbody>\n${rows}\n    </tbody></table>`;
}

function documentHeader(request: DocumentRequest, generatedAt: string): string {
  return `    <p class="meta">
      ${escapeHtml(request.templateName)} · instance ${escapeHtml(request.instanceId)}<br />
      Generated ${escapeHtml(generatedAt)}
    </p>`;
}

/** Fallback / no-AI mode: stamp the case input into a simple letter layout. */
function renderInputHtml(request: DocumentRequest, generatedAt: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(request.step.name)} — ${escapeHtml(request.templateName)}</title>
  <style>${STYLES}
  </style>
</head>
<body>
  <h1>${escapeHtml(request.step.name)}</h1>
${documentHeader(request, generatedAt)}
  <p class="body">${escapeHtml(request.step.description)}</p>
${inputTableHtml(request.input)}
</body>
</html>
`;
}

/**
 * AI mode: renders the structured content the drafter produced (title,
 * subtitle, sections, optional table) — the CASE branch's document shape —
 * followed by the raw case data so the file remains auditable against the
 * inputs that produced it.
 */
function renderStructuredHtml(
  request: DocumentRequest,
  content: DocumentContent,
  generatedAt: string,
): string {
  const sections = content.sections
    .map(
      (section) =>
        `  <h2>${escapeHtml(section.heading)}</h2>\n  <p class="body">${escapeHtml(section.body)}</p>`,
    )
    .join("\n");

  let table = "";
  if (content.table && content.table.headers.length > 0) {
    const headers = content.table.headers
      .map((header) => `<th>${escapeHtml(header)}</th>`)
      .join("");
    const rows = content.table.rows
      .map(
        (row) =>
          `      <tr>${content.table!.headers
            .map((_, index) => `<td>${escapeHtml(row[index] ?? "")}</td>`)
            .join("")}</tr>`,
      )
      .join("\n");
    table = `  <table class="data">\n    <thead><tr>${headers}</tr></thead>\n    <tbody>\n${rows}\n    </tbody>\n  </table>`;
  }

  const subtitle = content.subtitle
    ? `  <p class="subtitle">${escapeHtml(content.subtitle)}</p>\n`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(content.document_title)} — ${escapeHtml(request.templateName)}</title>
  <style>${STYLES}
  </style>
</head>
<body>
  <h1>${escapeHtml(content.document_title)}</h1>
${subtitle}  <p class="meta">
      ${escapeHtml(request.templateName)} · ${escapeHtml(request.step.name)} · instance ${escapeHtml(request.instanceId)}<br />
      Generated ${escapeHtml(generatedAt)} · content drafted by the AI model
    </p>
${sections}
${table}
  <p class="section-label">Case data</p>
${inputTableHtml(request.input)}
</body>
</html>
`;
}

/**
 * Writes one self-contained HTML document per (instance, step) into
 * `outputDir`. HTML keeps the module dependency-free and prints cleanly to
 * PDF from any browser.
 *
 * When a `DocumentContentPort` is wired, the body is drafted by the AI model
 * (CASE-style structured document content). If drafting fails — model down,
 * timeout, unusable output — the step still completes by rendering the case
 * input directly, and the result records `contentSource: "input"` so the
 * fallback is visible rather than silent.
 */
export class HtmlFileDocumentGenerator implements DocumentPort {
  constructor(
    private readonly outputDir: string,
    private readonly content?: DocumentContentPort,
  ) {}

  async generate(request: DocumentRequest): Promise<GeneratedDocument> {
    await fs.mkdir(this.outputDir, { recursive: true });
    const file = path.join(
      this.outputDir,
      `${request.instanceId}--${safeFileName(request.step.id)}.html`,
    );
    const generatedAt = new Date().toISOString();

    let drafted: DocumentContent | undefined;
    if (this.content) {
      try {
        drafted = await this.content.draft({
          templateName: request.templateName,
          stepName: request.step.name,
          stepDescription: request.step.description,
          input: request.input,
        });
      } catch (error) {
        console.warn(
          `[documents] AI content draft failed for ${request.instanceId}/${request.step.id}; rendering case input instead:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    const html = drafted
      ? renderStructuredHtml(request, drafted, generatedAt)
      : renderInputHtml(request, generatedAt);
    await fs.writeFile(file, html, "utf8");

    return {
      file,
      bytes: Buffer.byteLength(html, "utf8"),
      ...(drafted
        ? { contentSource: "ai" as const, title: drafted.document_title }
        : { contentSource: "input" as const }),
    };
  }
}
