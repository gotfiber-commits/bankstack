// Pulls plain text out of an uploaded résumé so the matcher can read it.
// PDF via pdf-parse, DOCX by unzipping word/document.xml. Legacy .doc files can't be read
// here, so they return null and matching falls back to the candidate's profile fields.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const clean = (t) =>
  t
    ? t
        .replace(/\u0000/g, " ")
        .replace(/[ \t\r]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 60000) || null
    : null;

export async function extractResumeText(bytes, ext) {
  try {
    if (ext === "pdf") {
      const pdfParse = require("pdf-parse/lib/pdf-parse.js");
      // pdf-parse misreads Node Buffers; a plain Uint8Array copy parses correctly
      const out = await pdfParse(new Uint8Array(bytes), { max: 20 }); // first 20 pages is plenty
      return clean(out.text);
    }
    if (ext === "docx") {
      const { unzipSync, strFromU8 } = await import("fflate");
      const doc = unzipSync(new Uint8Array(bytes))["word/document.xml"];
      if (!doc) return null;
      return clean(
        strFromU8(doc)
          .replace(/<\/w:p>/g, "\n")
          .replace(/<[^>]+>/g, " ")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#?\w+;/g, " ")
      );
    }
  } catch (err) {
    console.error("resume text extraction failed:", err.message);
  }
  return null;
}
