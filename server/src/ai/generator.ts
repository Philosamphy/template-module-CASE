import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOllama } from "@langchain/ollama";
import { z } from "zod";
import { FILE_TYPES, STEP_TYPES, WorkflowStepSchema } from "../domain/schemas.js";

/**
 * What the model may answer: either a full template, or a clarifying question
 * when the request is too thin to design from. `withStructuredOutput` needs a
 * single object schema, so both shapes share one flat envelope.
 */
const GenerationReplySchema = z.object({
  needsClarification: z.boolean(),
  question: z.string().max(600).optional(),
  name: z.string().max(200).optional(),
  steps: z.array(WorkflowStepSchema).optional(),
});

/**
 * The generator returns `unknown` on purpose. LangChain/Ollama output is
 * untrusted input: the service re-validates it with Zod and with the business
 * rules before anything is persisted.
 */
export interface TemplateGenerator {
  generate(prompt: string): Promise<unknown>;
}

export class AiGenerationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiGenerationError";
  }
}

const SYSTEM_PROMPT = `You are a workflow template designer for an approval-controlled operations system.

Your job is to turn the operator's description into a workflow template that matches EXACTLY what they asked for — their case, their checks, their approver, their output document — and nothing more.

Return ONLY an object with these fields:
- "needsClarification": boolean.
- "question": required when needsClarification is true: ONE focused question (max 600 chars).
- "name": a short template name (1-200 chars) when you can design the template.
- "steps": an ordered array of 1 to 20 steps when you can design the template. Each step has:
    - "id": a short unique slug, e.g. "step-1"
    - "name": 1-120 characters
    - "type": one of ${STEP_TYPES.map((type) => `"${type}"`).join(", ")}
    - "description": 1-1000 characters
    - "assignedRole" (optional): one of {roles}
    - "channel" (optional, notification only): "email" or "telegram"
    - "acceptedFileTypes" (optional, intake only): a subset of ${FILE_TYPES.map((type) => `"${type}"`).join(", ")}
    - "instruction" (optional, intake only): what the AI should read from the uploaded file

ASK FOR CLARIFICATION — do not guess — when the request does not say what the case is, what must be checked or approved, who approves it, or what the outcome/document should be. Do not invent facts, names, systems or documents the operator did not mention.

Hard rules:
1. The FIRST step must be type "review".
2. Every "approval" step must come after a "validation" step.
3. Step ids are unique; never add steps the operator did not ask for.
4. Use an "intake" step ONLY when the operator says a person must upload a PDF or image for the AI to read before the run can continue. Give it acceptedFileTypes and an instruction describing what to extract.
5. Use a "document" step only when the workflow produces a letter, report or form.
6. Never include fields for approval status, activation, permissions or sending anything. You are only proposing a template for a human to review; you cannot approve, activate or notify.

Typical shape (only when it matches the request):
review -> validation -> approval -> intake -> document -> notification`;

export interface OllamaGeneratorOptions {
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  supportedRoles: string[];
}

export class OllamaTemplateGenerator implements TemplateGenerator {
  private readonly llm: ChatOllama;
  private readonly chain: ReturnType<ChatPromptTemplate["pipe"]>;

  constructor(private readonly options: OllamaGeneratorOptions) {
    this.llm = new ChatOllama({
      model: options.model,
      baseUrl: options.baseUrl,
      temperature: options.temperature,
      // Qwen 3.5's default reasoning phase costs ~90s per call on this machine
      // and buys nothing for structured template design: generation drops from
      // a >90s timeout to ~14s end-to-end with it off.
      think: false,
    });

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", SYSTEM_PROMPT.replace("{roles}", options.supportedRoles.join(", "))],
      ["human", "{request}"],
    ]);

    const structured = this.llm.withStructuredOutput(GenerationReplySchema, {
      name: "workflow_template",
    });

    this.chain = prompt.pipe(structured);
  }

  async generate(request: string): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new AiGenerationError(
            `The language model at ${this.options.baseUrl} did not respond within ${this.options.timeoutMs}ms.`,
          ),
        );
      }, this.options.timeoutMs);
    });

    try {
      // The raw model output is still untrusted: the service validates it again.
      return await Promise.race([this.chain.invoke({ request }), timeout]);
    } catch (error) {
      if (error instanceof AiGenerationError) throw error;
      throw new AiGenerationError(
        `Template generation failed: the model could not be reached or returned an unusable response. (${this.options.model} @ ${this.options.baseUrl})`,
        { cause: error },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Test double: deterministic, no network. */
export class FixedTemplateGenerator implements TemplateGenerator {
  constructor(private readonly payload: unknown | (() => unknown)) {}

  async generate(_prompt: string): Promise<unknown> {
    return typeof this.payload === "function" ? (this.payload as () => unknown)() : this.payload;
  }
}
