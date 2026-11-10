import { ApiError } from "../domain/errors.js";

/** File kinds an intake step may accept. */
export type AcceptedFileType = "pdf" | "jpg" | "jpeg" | "png";

export interface ReadFileInput {
  buffer: Buffer;
  /** Original client file name (used for the extension and the audit row). */
  fileName: string;
  /** Declared MIME type; cross-checked against the extension. */
  mimeType: string;
  /** The intake step's acceptedFileTypes (already validated by the step). */
  accepted: string[];
  /** What the workflow wants the AI to look for in the file. */
  instruction?: string;
}

export interface ReadFileResult {
  /** Text read from the document (PDF text layer, or OCR for images). */
  text: string;
  /** The model's structured reading of that text, when one could be produced. */
  aiSummary: string | null;
  extraction: "pdf-text" | "ocr" | "none";
}

/**
 * Reads an uploaded case document. The execution layer only depends on this
 * port; `ai/fileReader.ts` supplies the PDF/OCR/model implementation.
 */
export interface FileReader {
  read(input: ReadFileInput): Promise<ReadFileResult>;
}

/** Used when no reader is configured (tests): uploading is refused clearly. */
export class UnavailableFileReader implements FileReader {
  async read(): Promise<ReadFileResult> {
    throw new ApiError(
      503,
      "FILE_READER_UNAVAILABLE",
      "Document reading is not configured on this server.",
    );
  }
}
