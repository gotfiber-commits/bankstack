// Résumé storage in Netlify Blobs (store "resumes").
// LOCAL_BLOBS_DIR switches to a folder on disk for tests outside Netlify.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStore } from "@netlify/blobs";

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const RESUME_TYPES = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// Checks the extension and the file's first bytes, so a renamed executable isn't accepted as a PDF.
export function checkResume(name, bytes) {
  const ext = String(name || "").toLowerCase().split(".").pop();
  if (!RESUME_TYPES[ext]) return { error: "Upload your résumé as a PDF or Word document." };
  if (bytes.length === 0) return { error: "That file is empty." };
  if (bytes.length > MAX_RESUME_BYTES) return { error: "Résumés can be up to 5 MB." };
  const head = bytes.subarray(0, 8);
  const isPdf = head.subarray(0, 5).toString("latin1") === "%PDF-";
  const isZip = head[0] === 0x50 && head[1] === 0x4b;                                     // .docx
  const isOle = head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])); // .doc
  if ((ext === "pdf" && !isPdf) || (ext === "docx" && !isZip) || (ext === "doc" && !isOle)) {
    return { error: "That file doesn't look like a real PDF or Word document." };
  }
  return { ext, type: RESUME_TYPES[ext] };
}

const local = () => process.env.LOCAL_BLOBS_DIR;
const store = () => getStore({ name: "resumes", consistency: "strong" });

export async function saveFile(key, bytes, metadata = {}) {
  if (local()) {
    const file = path.join(local(), key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    await writeFile(file + ".meta.json", JSON.stringify(metadata));
    return;
  }
  await store().set(key, bytes, { metadata });
}

export async function loadFile(key) {
  if (local()) {
    const file = path.join(local(), key);
    try {
      return { data: await readFile(file), metadata: JSON.parse(await readFile(file + ".meta.json", "utf8")) };
    } catch { return null; }
  }
  const r = await store().getWithMetadata(key, { type: "arrayBuffer" });
  return r ? { data: Buffer.from(r.data), metadata: r.metadata } : null;
}
