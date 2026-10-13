import { unzipSync } from "fflate";
import { __name } from "./utils.js";

export var OFFICE_MIMES = /* @__PURE__ */ new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);
function decodeEntities(value) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}
__name(decodeEntities, "decodeEntities");
function taggedText(xml, tag2) {
  const values = [];
  const pattern = new RegExp(`<${tag2}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag2}>`, "g");
  for (const match of xml.matchAll(pattern)) values.push(decodeEntities(match[1].replace(/<[^>]+>/g, "")).trim());
  return values.filter(Boolean);
}
__name(taggedText, "taggedText");
var MAX_OFFICE_ENTRIES = 200;
var MAX_OFFICE_ENTRY_BYTES = 5 * 1024 * 1024;
var MAX_OFFICE_TOTAL_BYTES = 10 * 1024 * 1024;
function shouldExtractOfficeEntry(name, mime) {
  if (mime.includes("wordprocessingml")) return name === "word/document.xml";
  if (mime.includes("presentationml")) return /^ppt\/slides\/slide\d+\.xml$/.test(name);
  if (mime.includes("spreadsheetml")) return name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
  return false;
}
__name(shouldExtractOfficeEntry, "shouldExtractOfficeEntry");
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
      }
    }), decoder3 = new TextDecoder(), values = [];
    if (mime.includes("wordprocessingml") && files["word/document.xml"]) {
      values.push(...taggedText(decoder3.decode(files["word/document.xml"]), "w:t"));
    } else if (mime.includes("presentationml")) {
      const slides = Object.keys(files).filter((x3) => /^ppt\/slides\/slide\d+\.xml$/.test(x3)).sort((a2, b3) => a2.localeCompare(b3, void 0, { numeric: true }));
      for (const slide of slides) values.push(...taggedText(decoder3.decode(files[slide]), "a:t"));
    } else if (mime.includes("spreadsheetml")) {
      const shared = files["xl/sharedStrings.xml"] ? taggedText(decoder3.decode(files["xl/sharedStrings.xml"]), "t") : [];
      const sheets = Object.keys(files).filter((x3) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x3)).sort((a2, b3) => a2.localeCompare(b3, void 0, { numeric: true }));
      for (const sheet of sheets) {
        const xml = decoder3.decode(files[sheet]);
        for (const cell of xml.matchAll(/<c(?:\s[^>]*)?>([\s\S]*?)<\/c>/g)) {
          const raw = cell[0], body = cell[1];
          const inline = taggedText(body, "t")[0];
          const value = taggedText(body, "v")[0];
          values.push(inline || (/\bt="s"/.test(raw) ? shared[Number(value)] : value) || "");
        }
      }
    }
    return values.filter(Boolean).join("\n").slice(0, 5e4);
  } catch {
    return "";
  }
}
__name(extractOfficeText, "extractOfficeText");
