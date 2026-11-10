import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentContentSchema, type DocumentContent } from "../src/ai/documentContent.js";
import type { WorkflowStep } from "../src/domain/schemas.js";
import {
  HtmlFileDocumentGenerator,
  type DocumentRequest,
} from "../src/execution/documents.js";

const step: WorkflowStep = {
  id: "step-4",
  name: "Generate Reply Letter",
  type: "document",
  description: "Generate a reply letter from the complaint details.",
};

const request: DocumentRequest = {
  instanceId: "22222222-2222-4222-8222-222222222222",
  templateName: "Complaint Letter Workflow",
  step,
  input: { complainant: "Ahmad Zulkifli", issue: "Water pipe burst" },
};

const drafted: DocumentContent = {
  document_title: "Complaint Reply Letter",
  subtitle: "1 November 2026",
  sections: [
    { heading: "Summary", body: "We have reviewed the complaint from Ahmad Zulkifli." },
    { heading: "Next steps", body: "A technician will be assigned to the location." },
  ],
  table: { headers: ["Field", "Value"], rows: [["complainant", "Ahmad Zulkifli"]] },
};

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "docgen-"));
}

describe("AI document content in the document step", () => {
  it("renders drafted structured content and keeps the case data for audit", async () => {
    const generator = new HtmlFileDocumentGenerator(await tempDir(), {
      draft: async () => drafted,
    });

    const out = await generator.generate(request);
    expect(out.contentSource).toBe("ai");
    expect(out.title).toBe("Complaint Reply Letter");
    expect(out.bytes).toBeGreaterThan(0);

    const html = await fs.readFile(out.file, "utf8");
    expect(html).toContain("Complaint Reply Letter");
    expect(html).toContain("1 November 2026");
    expect(html).toContain("We have reviewed the complaint from Ahmad Zulkifli.");
    expect(html).toContain("A technician will be assigned");
    expect(html).toContain("content drafted by the AI model");
    // The AI table renders…
    expect(html).toContain("<thead>");
    expect(html).toContain("Next steps");
    // …and the raw case input stays appended for auditability.
    expect(html).toContain("Case data");
    expect(html).toContain("Water pipe burst");
  });

  it("falls back to input rendering when drafting fails, and records it", async () => {
    const generator = new HtmlFileDocumentGenerator(await tempDir(), {
      draft: async () => {
        throw new Error("ollama unreachable");
      },
    });

    const out = await generator.generate(request);
    expect(out.contentSource).toBe("input");
    expect(out.title).toBeUndefined();

    const html = await fs.readFile(out.file, "utf8");
    expect(html).toContain("Ahmad Zulkifli");
    expect(html).toContain("Water pipe burst");
    expect(html).not.toContain("content drafted by the AI model");
  });

  it("renders the plain input table when no content port is wired", async () => {
    const generator = new HtmlFileDocumentGenerator(await tempDir());
    const out = await generator.generate(request);
    expect(out.contentSource).toBe("input");

    const html = await fs.readFile(out.file, "utf8");
    expect(html).toContain("Generate Reply Letter");
    expect(html).toContain("Ahmad Zulkifli");
  });

  it("the content schema accepts valid drafts and rejects malformed ones", () => {
    expect(DocumentContentSchema.safeParse(drafted).success).toBe(true);
    expect(
      DocumentContentSchema.safeParse({ document_title: "", sections: [] }).success,
    ).toBe(false);
    // Extra fields (like a model-supplied filename) are rejected outright.
    expect(
      DocumentContentSchema.safeParse({ ...drafted, filename: "../../evil.pdf" }).success,
    ).toBe(false);
  });
});
