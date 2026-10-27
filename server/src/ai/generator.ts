import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOllama } from "@langchain/ollama";
import { GeneratedTemplateSchema } from "../domain/schemas.js";

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

Design a workflow template from the operator's request.

Return ONLY an object with exactly these two fields:
- "name": a short template name (1-200 characters).
- "steps": an ordered array of 1 to 20 steps. Each step has:
    - "id": a short unique slug, e.g. "step-1"
    - "name": 1-120 characters
    - "type": one of "review", "validation", "approval", "notification"
    - "description": 1-1000 characters
    - "assignedRole" (optional): one of ${("{roles}")}

Hard rules:
1. The FIRST step must be type "review".
2. Every "approval" step must come after a "validation" step.
3. Step ids are unique.
4. Never include fields for approval status, activation, permissions, or sending anything. You are only proposing a template for a human to review; you cannot approve, activate or notify.

Template steps (examples of style):
review -> validation -> approval -> notification`;

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
    });

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", SYSTEM_PROMPT.replace("{roles}", options.supportedRoles.join(", "))],
      ["human", "{request}"],
    ]);

    const structured = this.llm.withStructuredOutput(GeneratedTemplateSchema, {
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
