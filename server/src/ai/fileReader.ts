import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOllama } from "@langchain/ollama";
import Jimp from "jimp";
import { createWorker, PSM } from "tesseract.js";
import { ApiError, unprocessable } from "../domain/errors.js";
import type { FileReader, ReadFileInput, ReadFileResult } from "../execution/intake.js";

export interface OllamaFileReaderOptions {
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
}

const MIME_BY_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

const SYSTEM_PROMPT = `You read case documents for an approval workflow.
You are given text extracted from an uploaded PDF or image, plus what the workflow needs from it.
Return a short, factual plain-text summary of ONLY the information present in the text.
Never invent names, dates, amounts, reference numbers or decisions. If a requested detail is missing, say "not stated".
Keep it under 250 words.`;

function fileTypeOf(fileName: string): "pdf" | "jpg" | "jpeg" | "png" | null {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  return extension === "pdf" || extension === "jpg" || extension === "jpeg" || extension === "png"
    ? extension
    : null;
}

/** Images accept both jpg spellings; everything else must match exactly. */
function isAccepted(type: string, accepted: string[]): boolean {
  const normalized = type === "jpeg" ? "jpg" : type;
  return accepted.some((entry) => (entry === "jpeg" ? "jpg" : entry) === normalized);
}

/**
 * Normalises an uploaded bitmap before OCR: greyscale, upscaled when the text
 * is small, contrast stretched. Falls back to the original bytes so tesseract
 * can report the real problem with an unreadable file.
 */
async function prepareImage(buffer: Buffer): Promise<Buffer> {
  try {
    const image = await Jimp.read(buffer);
    image.grayscale();
    const longest = Math.max(image.bitmap.width, image.bitmap.height);
    if (longest > 0 && longest < 1400) {
      image.scale(Math.min(3, Math.ceil(1400 / longest)));
    }
    image.normalize().contrast(0.15);
    return await image.getBufferAsync(Jimp.MIME_PNG);
  } catch {
    return buffer;
  }
}

/** Maps pdfjs failures to messages the operator can act on. */
function pdfFailure(error: unknown): ApiError {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "PasswordException") {
    return unprocessable(
      "This PDF is password-protected. Upload an unlocked copy, or a JPG/PNG of the pages.",
    );
  }
  if (name === "InvalidPDFException") {
    return unprocessable("This file is damaged or is not a valid PDF.");
  }
  console.warn(
    "[fileReader] PDF extraction failed:",
    name || "unknown",
    (error as { message?: string } | null)?.message ?? "",
  );
  return unprocessable("The PDF could not be read. Try exporting it again.");
}

interface PdfImage {
  width: number;
  height: number;
  kind: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Converts a pdfjs image object to a PNG buffer tesseract can read. */
async function pdfImageToPng(
  image: PdfImage,
  kinds: { GRAYSCALE_1BPP?: number; RGB_24BPP?: number; RGBA_32BPP?: number },
): Promise<Buffer | null> {
  const { width, height, data } = image;
  if (!width || !height || !data) return null;

  const rgba = Buffer.alloc(width * height * 4);
  if (image.kind === kinds.RGBA_32BPP) {
    Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(rgba);
  } else if (image.kind === kinds.RGB_24BPP) {
    for (let i = 0, j = 0; i < width * height; i += 1, j += 3) {
      rgba[i * 4] = data[j] ?? 0;
      rgba[i * 4 + 1] = data[j + 1] ?? 0;
      rgba[i * 4 + 2] = data[j + 2] ?? 0;
      rgba[i * 4 + 3] = 255;
    }
  } else if (image.kind === kinds.GRAYSCALE_1BPP) {
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const byte = data[y * rowBytes + (x >> 3)] ?? 0;
        const bit = (byte >> (7 - (x & 7))) & 1;
        const value = bit ? 255 : 0;
        const offset = (y * width + x) * 4;
        rgba[offset] = value;
        rgba[offset + 1] = value;
        rgba[offset + 2] = value;
        rgba[offset + 3] = 255;
      }
    }
  } else {
    return null;
  }

  const bitmap = new Jimp({ data: rgba, width, height });
  return bitmap.getBufferAsync(Jimp.MIME_PNG);
}

/** Embedded page images of a PDF page, as PNG buffers (first few only). */
async function pageImages(
  pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs"),
  page: { getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>; objs: { get: (id: string, callback: (value: unknown) => void) => void } },
): Promise<Buffer[]> {
  const images: Buffer[] = [];
  const seen = new Set<string>();
  const ops = await page.getOperatorList();

  for (let index = 0; index < ops.fnArray.length; index += 1) {
    if (ops.fnArray[index] !== pdfjs.OPS.paintImageXObject) continue;
    const name = ops.argsArray[index]?.[0];
    if (typeof name !== "string" || seen.has(name)) continue;
    seen.add(name);

    const image = await new Promise<PdfImage | null>((resolve) => {
      try {
        page.objs.get(name, (value) => resolve((value as PdfImage) ?? null));
      } catch {
        resolve(null);
      }
    });
    if (!image) continue;

    const png = await pdfImageToPng(image, pdfjs.ImageKind).catch(() => null);
    if (png) images.push(png);
    if (images.length >= 3) break;
  }

  return images;
}

/**
 * Reads uploaded case documents: the PDF text layer when there is one, OCR for
 * images, then the configured model turns the extracted text into a short,
 * factual reading the workflow can act on. Nothing is sent anywhere and the
 * model never sees anything but extracted text.
 */
export class OllamaFileReader implements FileReader {
  private readonly summarizer: ReturnType<ChatPromptTemplate["pipe"]>;

  constructor(private readonly options: OllamaFileReaderOptions) {
    const llm = new ChatOllama({
      model: options.model,
      baseUrl: options.baseUrl,
      temperature: 0,
      think: false,
    });

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", SYSTEM_PROMPT],
      [
        "human",
        "What the workflow needs: {instruction}\n\nExtracted document text:\n{text}",
      ],
    ]);

    this.summarizer = prompt.pipe(llm);
  }

  async read(input: ReadFileInput): Promise<ReadFileResult> {
    const type = fileTypeOf(input.fileName);
    if (!type) {
      throw unprocessable("Only PDF, JPG and PNG files can be read.");
    }
    if (!isAccepted(type, input.accepted)) {
      throw unprocessable(
        `This step accepts ${input.accepted.join(", ")} — the uploaded file is ${type}.`,
      );
    }
    const expectedMime = MIME_BY_TYPE[type];
    if (input.mimeType && expectedMime && input.mimeType !== expectedMime) {
      throw unprocessable("The file's content type does not match its extension.");
    }

    let text = "";
    let extraction: ReadFileResult["extraction"] = "none";

    if (type === "pdf") {
      let pages: Awaited<ReturnType<typeof this.pdfText>>;
      try {
        pages = await this.pdfText(input.buffer);
      } catch (error) {
        throw pdfFailure(error);
      }
      text = pages.text;
      extraction = "pdf-text";

      // Scanned/enriched PDFs carry no text layer: read the embedded page
      // images instead of refusing the upload.
      if (text.trim().length < 3 && pages.images.length > 0) {
        text = await this.ocrAll(pages.images);
        extraction = "ocr";
      }
    } else {
      text = await this.ocr(input.buffer);
      extraction = "ocr";
    }

    text = text.replace(/\r\n/g, "\n").trim();
    if (text.length < 3) {
      throw unprocessable(
        "No readable text was found in this file. Scanned documents need a text layer or a clearer image.",
      );
    }

    return {
      text: text.slice(0, 50_000),
      aiSummary: await this.summarize(text, input.instruction),
      extraction,
    };
  }

  /**
   * PDF text layer (pdfjs, legacy build — no canvas or DOM required). Also
   * collects the embedded page images so a scanned PDF can be OCR'd when the
   * text layer is empty.
   */
  private async pdfText(
    buffer: Buffer,
  ): Promise<{ text: string; images: Buffer[] }> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await pdfjs
      .getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: true,
        isEvalSupported: false,
      })
      .promise;

    const pages: string[] = [];
    const images: Buffer[] = [];
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(
          content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" "),
        );

        if (pages.join("").trim().length < 3 && pageNumber <= 3) {
          images.push(...(await pageImages(pdfjs, page)));
        }
        page.cleanup();
      }
    } finally {
      await document.destroy().catch(() => undefined);
    }

    return { text: pages.join("\n"), images };
  }

  /** OCR every page image collected from a scanned PDF, in page order. */
  private async ocrAll(images: Buffer[]): Promise<string> {
    const parts: string[] = [];
    for (const image of images.slice(0, 3)) {
      try {
        parts.push(await this.ocr(image));
      } catch {
        // One unreadable page image should not discard the readable ones.
      }
    }
    return parts.join("\n");
  }

  /**
   * Image OCR. tesseract runs locally; the language data is fetched once.
   *
   * The bitmap is normalised first (greyscale, upscaled when small, contrast
   * stretched) because phone photos and screenshots otherwise read as noise.
   *
   * A worker failure is reported through an `error` callback: without one,
   * tesseract throws from its message handler, which is an uncaught exception
   * and takes the whole API process down instead of failing this one upload.
   */
  private async ocr(buffer: Buffer): Promise<string> {
    const prepared = await prepareImage(buffer);
    let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
    let workerError: string | null = null;
    try {
      worker = await createWorker("eng", undefined, {
        errorHandler: (error: unknown) => {
          workerError = typeof error === "string" ? error : "OCR worker failed.";
        },
      });
      // AUTO segmentation reads whole pages/forms; the default single-block
      // mode mangles multi-column or sparse material.
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        preserve_interword_spaces: "1",
      });
      const { data } = await worker.recognize(prepared);
      if (workerError) throw unprocessable(workerError);
      return data.text ?? "";
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unprocessable(
        "The image could not be read by OCR. Upload a sharper JPG/PNG, or a PDF with a text layer.",
      );
    } finally {
      if (worker) await worker.terminate().catch(() => undefined);
    }
  }

  /** The model's reading of the extracted text; null when it is unavailable. */
  private async summarize(text: string, instruction?: string): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.min(this.options.timeoutMs, 45_000));
    });

    try {
      const result = await Promise.race([
        this.summarizer.invoke({
          instruction: instruction ?? "Summarise the document for the approver.",
          text: text.slice(0, 12_000),
        }),
        timeout,
      ]);
      if (!result) return null;
      const content = (result as { content?: unknown }).content;
      const summary =
        typeof content === "string" ? content.trim() : JSON.stringify(content ?? "").slice(0, 4000);
      return summary.length > 0 ? summary : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Test double: returns whatever text it is constructed with. */
export class FixedFileReader implements FileReader {
  constructor(
    private readonly result: ReadFileResult = {
      text: "Readable case document text.",
      aiSummary: null,
      extraction: "pdf-text",
    },
  ) {}

  async read(_input: ReadFileInput): Promise<ReadFileResult> {
    return this.result;
  }
}
