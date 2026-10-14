const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { env } = require('../config/env');

function ocrRequiredError(message) {
  const err = new Error(
    message ||
      'No selectable text found in the PDF. This appears to be a scanned document — OCR is required before importing.'
  );
  err.code = 'OCR_REQUIRED';
  return err;
}

// Render a pdf.js page to text, keeping line breaks based on the text baseline.
function pageToText(items) {
  let lastY;
  let text = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform ? item.transform[5] : undefined;
    if (lastY === y || lastY === undefined) text += item.str;
    else text += `\n${item.str}`;
    lastY = y;
  }
  return text;
}

// Direct pdf.js extraction with error recovery (handles slightly malformed xref tables).
async function extractPdfTextWithPdfJs(buf) {
  const PDFJS = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
  PDFJS.disableWorker = true;
  const doc = await PDFJS.getDocument({ data: new Uint8Array(buf), stopAtErrors: false });
  const maxPages = env.MAX_IMPORT_PAGES > 0 ? Math.min(doc.numPages, env.MAX_IMPORT_PAGES) : doc.numPages;
  const parts = [];
  for (let i = 1; i <= maxPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(pageToText(content.items));
  }
  return parts.join('\n').trim();
}

async function extractPdfText(filePath) {
  const buf = fs.readFileSync(filePath);
  const PDFParse = require('pdf-parse');
  let text = '';
  let firstError = null;
  try {
    const result = await PDFParse(buf, env.MAX_IMPORT_PAGES > 0 ? { max: env.MAX_IMPORT_PAGES } : undefined);
    text = (result && result.text ? result.text : '').trim();
  } catch (e) {
    firstError = e;
  }
  if (!text) {
    // Fall back to pdf.js directly. This recovers PDFs whose xref table is
    // slightly malformed but whose objects are still readable.
    try {
      text = await extractPdfTextWithPdfJs(buf);
    } catch (e) {
      if (firstError) {
        const err = new Error(`Could not read PDF: ${firstError.message}`);
        err.code = 'PARSE_FAILED';
        throw err;
      }
      throw e;
    }
  }
  if (!text) throw ocrRequiredError();
  return text;
}

async function extractDocxText(filePath) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return (result.value || '').trim();
}

function runConverter(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout || '');
    });
  });
}

// Legacy .doc files are binary. Convert with a safe, non-executing converter when
// one is available (textutil on macOS, antiword/catdoc elsewhere). Macros are never run.
async function extractDocText(filePath) {
  const attempts = [
    ['textutil', ['-convert', 'txt', '-stdout', filePath]],
    ['antiword', [filePath]],
    ['catdoc', [filePath]],
  ];
  let lastErr = null;
  for (const [cmd, args] of attempts) {
    try {
      const out = await runConverter(cmd, args);
      const text = String(out).trim();
      if (text) return text;
    } catch (e) {
      lastErr = e;
      if (e.code === 'ENOENT') continue;
    }
  }
  const err = new Error(
    `Could not extract text from "${path.basename(filePath)}". Legacy .doc conversion requires one of: textutil (macOS), antiword, or catdoc. Please save the document as .docx or .pdf and try again.`
  );
  err.code = 'DOC_CONVERSION_UNAVAILABLE';
  if (lastErr) err.cause = lastErr.message;
  throw err;
}

function extractTxtText(filePath) {
  const raw = fs.readFileSync(filePath);
  let text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.trim();
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return extractPdfText(filePath);
  if (ext === '.docx') return extractDocxText(filePath);
  if (ext === '.doc') return extractDocText(filePath);
  if (ext === '.txt') return extractTxtText(filePath);
  const err = new Error(`Unsupported file type: ${ext}`);
  err.code = 'UNSUPPORTED_TYPE';
  throw err;
}

module.exports = { extractText, extractPdfText, extractDocxText, extractDocText, extractTxtText };
