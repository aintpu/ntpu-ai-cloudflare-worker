import { unzipSync } from "fflate";

export const OFFICE_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function decodeEntities(value) {
  return value
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&").replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function taggedText(xml, tag) {
  const values = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g");
  for (const match of xml.matchAll(pattern)) values.push(decodeEntities(match[1].replace(/<[^>]+>/g, "")).trim());
  return values.filter(Boolean);
}

const MAX_OFFICE_ENTRIES = 200;
const MAX_OFFICE_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_OFFICE_TOTAL_BYTES = 10 * 1024 * 1024;
function shouldExtractOfficeEntry(name, mime) {
  if (mime.includes("wordprocessingml")) return name === "word/document.xml";
  if (mime.includes("presentationml")) return /^ppt\/slides\/slide\d+\.xml$/.test(name);
  if (mime.includes("spreadsheetml")) return name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
  return false;
}
export function extractOfficeText(bytes, mime) {
  try {
    let entryCount = 0, totalBytes = 0;
    const files = unzipSync(bytes, {
      filter(file) {
        entryCount++;
        const originalSize = Number(file.originalSize);
        if (entryCount > MAX_OFFICE_ENTRIES || !Number.isSafeInteger(originalSize) || originalSize < 0 || originalSize > MAX_OFFICE_ENTRY_BYTES) throw new Error("Office archive entry exceeds limits");
        totalBytes += originalSize;
        if (totalBytes > MAX_OFFICE_TOTAL_BYTES) throw new Error("Office archive exceeds limits");
        return shouldExtractOfficeEntry(file.name, mime);
      },
    }), decoder = new TextDecoder(), values = [];
    if (mime.includes("wordprocessingml") && files["word/document.xml"]) {
      values.push(...taggedText(decoder.decode(files["word/document.xml"]), "w:t"));
    } else if (mime.includes("presentationml")) {
      const slides = Object.keys(files).filter(x => /^ppt\/slides\/slide\d+\.xml$/.test(x)).sort((a,b) => a.localeCompare(b, undefined, { numeric:true }));
      for (const slide of slides) values.push(...taggedText(decoder.decode(files[slide]), "a:t"));
    } else if (mime.includes("spreadsheetml")) {
      const shared = files["xl/sharedStrings.xml"] ? taggedText(decoder.decode(files["xl/sharedStrings.xml"]), "t") : [];
      const sheets = Object.keys(files).filter(x => /^xl\/worksheets\/sheet\d+\.xml$/.test(x)).sort((a,b) => a.localeCompare(b, undefined, { numeric:true }));
      for (const sheet of sheets) {
        const xml = decoder.decode(files[sheet]);
        for (const cell of xml.matchAll(/<c(?:\s[^>]*)?>([\s\S]*?)<\/c>/g)) {
          const raw = cell[0], body = cell[1];
          const inline = taggedText(body, "t")[0];
          const value = taggedText(body, "v")[0];
          values.push(inline || (/\bt="s"/.test(raw) ? shared[Number(value)] : value) || "");
        }
      }
    }
    return values.filter(Boolean).join("\n").slice(0, 50000);
  } catch {
    return "";
  }
}
