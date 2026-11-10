import PDFDocument from "pdfkit";
import {
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { DocumentContent } from "../ai/documentContent.js";

/**
 * Real-file exporters for `document` steps: PDF (pdfkit) and Word (docx).
 * These mirror the CASE branch's `feature/web-ui` builders —
 * `pdf/pdf_builder.py` (reportlab) and `word/word_builder.py` (python-docx) —
 * with the same layout DNA: letter page, generous margins, a dark-slate
 * title, slate subtitle, section headings, body text, and a blue-headed data
 * table.
 *
 * Both renderers take *structured content only*, never paths or file names:
 * where a file lands stays with the caller (`documents.ts`), so nothing in
 * here can be steered outside the output directory.
 */
export interface DocumentExportSpec {
  content: DocumentContent;
  meta: {
    templateName: string;
    stepName: string;
    instanceId: string;
    generatedAt: string;
  };
  /**
   * Raw case input appended as an "Case data" audit table — HTML parity for
   * AI-drafted documents. Omitted when the content itself already *is* the
   * input (the no-AI fallback), which would otherwise duplicate it.
   */
  auditInput?: Record<string, string>;
}

/** Palette + type scale taken from the CASE builders (reportlab / python-docx). */
const C = {
  title: "#1e293b",
  subtitle: "#64748b",
  heading: "#0f172a",
  body: "#334155",
  tableHead: "#2563eb",
  tableHeadText: "#f5f5f5", // reportlab used whitesmoke
  tableGrid: "#cbd5e1",
  tableRow: "#f8fafc",
} as const;

type PdfDoc = InstanceType<typeof PDFDocument>;

/**
 * Draws a bordered table with absolute positioning (pdfkit has no table
 * layout). Row heights are measured first so a row is never split across a
 * page break; when the page runs out, a new one starts.
 */
function drawPdfTable(doc: PdfDoc, headers: string[], rows: string[][]): void {
  const left = doc.page.margins.left;
  const pageWidth = doc.page.width - left - doc.page.margins.right;
  const bottomY = () => doc.page.height - doc.page.margins.bottom;
  const colWidth = pageWidth / headers.length;
  const pad = 6;

  let y = doc.y + 6;
  const ensureRoom = (height: number) => {
    if (y + height > bottomY()) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  };

  // Header row: blue fill, bold whitesmoke text (as in pdf_builder.py).
  doc.font("Helvetica-Bold").fontSize(10);
  const headerHeight = Math.max(
    24,
    ...headers.map(
      (header) => doc.heightOfString(header, { width: colWidth - pad * 2 }) + pad * 2,
    ),
  );
  ensureRoom(headerHeight);
  headers.forEach((header, index) => {
    const x = left + index * colWidth;
    doc.rect(x, y, colWidth, headerHeight).fillAndStroke(C.tableHead, C.tableGrid);
    doc.fillColor(C.tableHeadText).text(header, x + pad, y + pad, {
      width: colWidth - pad * 2,
    });
  });
  y += headerHeight;

  doc.font("Helvetica").fontSize(9);
  for (const row of rows) {
    const rowHeight = Math.max(
      20,
      ...headers.map(
        (_, index) =>
          doc.heightOfString(row[index] ?? "", { width: colWidth - pad * 2 }) + pad * 2,
      ),
    );
    ensureRoom(rowHeight);
    headers.forEach((_, index) => {
      const x = left + index * colWidth;
      doc.rect(x, y, colWidth, rowHeight).fillAndStroke(C.tableRow, C.tableGrid);
      doc.fillColor(C.body).text(row[index] ?? "", x + pad, y + pad, {
        width: colWidth - pad * 2,
      });
    });
    y += rowHeight;
  }

  // Hand the flow cursor back below the table for whatever comes next.
  doc.x = left;
  doc.y = y + 10;
}

/**
 * Renders the structured content to a PDF buffer (letter page, 36pt margins —
 * the same geometry as pdf_builder.py).
 *
 * Streams are written uncompressed on purpose: the artifact stays greppable,
 * so an auditor (or a test) can read the document text straight out of the
 * file it produced.
 */
export function renderPdf(spec: DocumentExportSpec): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 36, bottom: 36, left: 36, right: 36 },
      compress: false,
      info: {
        Title: spec.content.document_title,
        Author: "Workflow Template Console",
        Creator: "template-module",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const { content, meta } = spec;

    doc.font("Helvetica-Bold").fontSize(22).fillColor(C.title).text(content.document_title, {
      lineGap: 2,
    });
    if (content.subtitle) {
      doc.moveDown(0.3).font("Helvetica").fontSize(11).fillColor(C.subtitle).text(content.subtitle, {
        lineGap: 2,
      });
    }
    doc.moveDown(0.5)
      .font("Helvetica")
      .fontSize(9)
      .fillColor(C.subtitle)
      .text(
        `${meta.templateName} · ${meta.stepName} · instance ${meta.instanceId}\nGenerated ${meta.generatedAt}`,
      );
    doc.moveDown(0.6);

    for (const section of content.sections) {
      doc.font("Helvetica-Bold").fontSize(14).fillColor(C.heading).text(section.heading, {
        lineGap: 2,
      });
      doc.moveDown(0.2);
      doc.font("Helvetica").fontSize(10).fillColor(C.body).text(section.body, { lineGap: 4 });
      doc.moveDown(0.7);
    }

    if (content.table && content.table.headers.length > 0) {
      drawPdfTable(doc, content.table.headers, content.table.rows);
    }

    const audit = spec.auditInput ? Object.entries(spec.auditInput) : [];
    if (audit.length > 0) {
      doc.font("Helvetica-Bold").fontSize(11).fillColor(C.heading).text("Case data");
      drawPdfTable(
        doc,
        ["Field", "Value"],
        audit.map(([key, value]) => [key, value]),
      );
    }

    doc.end();
  });
}

/** One paragraph; embedded newlines become Word line breaks. */
function docxParagraph(
  text: string,
  opts: {
    size: number; // half-points (24 = 12pt)
    color: string;
    bold?: boolean;
    italics?: boolean;
    spacing: { before?: number; after?: number; line?: number };
  },
): Paragraph {
  const lines = text.split("\n");
  return new Paragraph({
    spacing: opts.spacing,
    children: lines.map(
      (line, index) =>
        new TextRun({
          text: line,
          ...(index > 0 ? { break: 1 } : {}),
          font: "Calibri",
          size: opts.size,
          color: opts.color,
          ...(opts.bold ? { bold: true } : {}),
          ...(opts.italics ? { italics: true } : {}),
        }),
    ),
  });
}

/** Bordered table with the CASE header styling (blue fill, bold light text). */
function docxTable(headers: string[], rows: string[][]): Table {
  const edge = { style: BorderStyle.SINGLE, size: 4, color: C.tableGrid.slice(1) } as const;
  const borders = { top: edge, bottom: edge, left: edge, right: edge };
  const columnWidth = Math.max(1, Math.floor(5000 / headers.length)); // fiftieths of a percent

  const cell = (text: string, isHeader: boolean): TableCell =>
    new TableCell({
      borders,
      shading: {
        type: ShadingType.CLEAR,
        fill: (isHeader ? C.tableHead : C.tableRow).slice(1),
        color: "auto",
      },
      width: { size: columnWidth, type: WidthType.PERCENTAGE },
      children: [
        new Paragraph({
          spacing: { after: 40 },
          children: [
            new TextRun({
              text,
              font: "Calibri",
              size: isHeader ? 20 : 18,
              ...(isHeader ? { bold: true } : {}),
              color: (isHeader ? C.tableHeadText : C.body).slice(1),
            }),
          ],
        }),
      ],
    });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((header) => cell(header, true)),
      }),
      ...rows.map(
        (row) =>
          new TableRow({
            children: headers.map((_, index) => cell(row[index] ?? "", false)),
          }),
      ),
    ],
  });
}

/**
 * Renders the structured content to a .docx buffer — 1-inch margins, Calibri,
 * dark-blue title, slate subtitle: word_builder.py's styling translated to
 * the `docx` package.
 */
export async function renderDocx(spec: DocumentExportSpec): Promise<Buffer> {
  const { content, meta } = spec;
  const children: (Paragraph | Table)[] = [];

  children.push(
    docxParagraph(content.document_title, {
      size: 48,
      color: "1F4979",
      bold: true,
      spacing: { after: 40 },
    }),
  );
  if (content.subtitle) {
    children.push(
      docxParagraph(content.subtitle, {
        size: 24,
        color: C.subtitle.slice(1),
        italics: true,
        spacing: { after: 160 },
      }),
    );
  }
  children.push(
    docxParagraph(`${meta.templateName} · ${meta.stepName} · instance ${meta.instanceId}`, {
      size: 18,
      color: C.subtitle.slice(1),
      spacing: { after: 20 },
    }),
  );
  children.push(
    docxParagraph(`Generated ${meta.generatedAt}`, {
      size: 18,
      color: C.subtitle.slice(1),
      spacing: { after: 240 },
    }),
  );

  for (const section of content.sections) {
    children.push(
      docxParagraph(section.heading, {
        size: 28,
        color: C.heading.slice(1),
        bold: true,
        spacing: { before: 240, after: 80 },
      }),
    );
    children.push(
      docxParagraph(section.body, {
        size: 22,
        color: C.body.slice(1),
        spacing: { after: 120, line: 276 }, // 1.15 line spacing, as in word_builder.py
      }),
    );
  }

  if (content.table && content.table.headers.length > 0) {
    children.push(docxTable(content.table.headers, content.table.rows));
  }

  const audit = spec.auditInput ? Object.entries(spec.auditInput) : [];
  if (audit.length > 0) {
    children.push(
      docxParagraph("Case data", {
        size: 22,
        color: C.heading.slice(1),
        bold: true,
        spacing: { before: 240, after: 80 },
      }),
    );
    children.push(
      docxTable(
        ["Field", "Value"],
        audit.map(([key, value]) => [key, value]),
      ),
    );
  }

  const document = new Document({
    title: content.document_title,
    sections: [
      {
        properties: {
          page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } }, // 1 inch
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(document);
}
