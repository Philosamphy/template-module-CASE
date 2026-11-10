import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOllama } from "@langchain/ollama";
import { z } from "zod";
import type { DocumentContentPort, DocumentContentRequest } from "../execution/documents.js";
import { AiGenerationError } from "./generator.js";

/**
 * Structured content for one generated document. This mirrors the CASE
 * platform's `feature/web-ui` `PDFDocumentSchema` (title / subtitle / sections /
 * optional table) — minus `filename`: file names are derived server-side from
 * the instance and step ids, so the model can never influence where a file is
 * written.
 *
 * Like template generation, the model's output is untrusted: the drafter
 * re-validates it against this schema before returning it.
 */
export const DocumentContentSchema = z
  .object({
    document_title: z.string().trim().min(1).max(200),
    subtitle: z.string().trim().max(300).nullish(),
    sections: z
      .array(
        z
          .object({
            heading: z.string().trim().min(1).max(200),
            body: z.string().trim().min(1).max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    table: z
      .object({
        headers: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
        rows: z.array(z.array(z.string().max(1000)).max(12)).max(60),
      })
      .strict()
      .nullish(),
  })
  .strict();

export type DocumentContent = z.infer<typeof DocumentContentSchema>;

/**
 * Adapted from the CASE branch's "Executive Document Designer" prompt: same
 * job (turn a request into title/sections/table), but the request here is the
 * workflow's case data, and the model must not invent facts beyond it.
 */
const SYSTEM_PROMPT = `You are an expert Executive Document Designer.
Your job is to convert workflow case data into a clear, well-structured document.
REQUIREMENTS:
1. Provide a strong document title and a helpful subtitle.
2. Structure the text into logical sections with descriptive headings and body paragraphs.
3. If the case data contains numbers, metrics, or comparison data, include a formatted table with column headers.
4. Use only facts present in the case data supplied; never invent names, dates, figures, or decisions.
5. Do not claim that anything was approved, sent, or completed unless the case data says so.`;

const HUMAN_TEMPLATE = `Template: {templateName}
Step: {stepName} — {stepDescription}
Case data (JSON):
{input}`;

export interface OllamaDocumentContentOptions {
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
}

/**
 * Ollama-backed drafter for `document` steps. Same call pattern as template
 * generation: structured output, thinking disabled (Qwen 3.5's reasoning phase
 * costs ~90s per call here and buys nothing for document layout), and a hard
 * timeout so a stuck model fails the draft instead of hanging the run — the
 * document port then falls back to rendering the case input.
 */
export class OllamaDocumentContentGenerator implements DocumentContentPort {
  private readonly chain: ReturnType<ChatPromptTemplate["pipe"]>;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaDocumentContentOptions) {
    const llm = new ChatOllama({
      model: options.model,
      baseUrl: options.baseUrl,
      temperature: options.temperature,
      think: false,
    });

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", SYSTEM_PROMPT],
      ["human", HUMAN_TEMPLATE],
    ]);

    const structured = llm.withStructuredOutput(DocumentContentSchema, {
      name: "document_content",
    });

    this.chain = prompt.pipe(structured);
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
  }

  async draft(request: DocumentContentRequest): Promise<DocumentContent> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new AiGenerationError(
            `The language model at ${this.baseUrl} did not respond within ${this.timeoutMs}ms.`,
          ),
        );
      }, this.timeoutMs);
    });

    try {
      const raw = await Promise.race([
        this.chain.invoke({
          templateName: request.templateName,
          stepName: request.stepName,
          stepDescription: request.stepDescription,
          input: JSON.stringify(request.input, null, 2),
        }),
        timeout,
      ]);

      // Re-validate even though withStructuredOutput parsed once: AI output is
      // untrusted input at every boundary.
      const parsed = DocumentContentSchema.safeParse(raw);
      if (!parsed.success) {
        throw new AiGenerationError("The model returned unusable document content.");
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof AiGenerationError) throw error;
      throw new AiGenerationError("Document content drafting failed.", {
        cause: error,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
