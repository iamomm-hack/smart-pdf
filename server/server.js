const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const sharp = require("sharp");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const rateLimit = require("express-rate-limit");

let poppler = null;
let popplerLoadError = null;
let createWorker = null;
let ocrLoadError = null;

try {
  poppler = require("pdf-poppler");
} catch (error) {
  popplerLoadError = error;
}

try {
  ({ createWorker } = require("tesseract.js"));
} catch (error) {
  ocrLoadError = error;
}

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_ROOT = path.join(__dirname, "..");

// ─── Directory Setup ───────────────────────────────────────────────
const DIRS = {
  uploads: path.join(TEMP_ROOT, "uploads"),
  processed: path.join(TEMP_ROOT, "processed"),
  images: path.join(TEMP_ROOT, "images"),
  client: path.join(__dirname, "..", "client"),
};

for (const dir of [DIRS.uploads, DIRS.processed, DIRS.images]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ─── In-memory job tracking ────────────────────────────────────────
const jobs = new Map();
const sseClients = new Map(); // jobId → [response objects]

// ─── Rate Limiting ─────────────────────────────────────────────────
const convertLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: {
    error: "Too many conversions. Please try again later (max 10/hour).",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Multer Configuration ──────────────────────────────────────────
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DIRS.uploads),
  filename: (req, file, cb) => {
    // Sanitize filename: strip path separators, null bytes, etc.
    const safeName = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${uuidv4()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are allowed."));
    }
    cb(null, true);
  },
}).single("pdf");

// ─── Middleware ─────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(DIRS.client));
app.get("/", (_req, res) => {
  const indexPath = path.join(DIRS.client, "index.html");

  if (!fs.existsSync(indexPath)) {
    return res.status(503).send("Smart PDF frontend files are missing.");
  }

  res.sendFile(indexPath);
});

// ─── Helpers ───────────────────────────────────────────────────────

/** Validate PDF magic bytes */
function validatePdfMagic(filePath) {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  return buf.equals(PDF_MAGIC);
}

function buildDownloadFileName(originalName) {
  const parsed = path.parse(originalName || "document.pdf");
  const baseName =
    (parsed.name || "document")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "document";

  return `${baseName}_converted.pdf`;
}

function ensurePopplerAvailable() {
  if (poppler) {
    return poppler;
  }

  const details = popplerLoadError?.message
    ? ` ${popplerLoadError.message}`
    : "";
  const platformHint = IS_VERCEL
    ? " This deployment is running on Vercel, where Poppler binaries are commonly unavailable for serverless functions."
    : "";

  throw new Error(
    `PDF conversion engine is unavailable because pdf-poppler could not be loaded.${platformHint}${details}`.trim(),
  );
}

function ensureOcrAvailable() {
  if (createWorker) {
    return createWorker;
  }

  const details = ocrLoadError?.message ? ` ${ocrLoadError.message}` : "";
  throw new Error(
    `OCR engine is unavailable because tesseract.js could not be loaded.${details}`.trim(),
  );
}

function getProcessingProfile(mode) {
  if (mode === "fast") {
    return {
      mode: "fast",
      popplerScale: 1400,
      ocrDpi: 150,
      sharpenSigma: 0.6,
      pngCompressionLevel: 9,
    };
  }

  return {
    mode: "standard",
    popplerScale: 2400,
    ocrDpi: 300,
    sharpenSigma: 1.0,
    pngCompressionLevel: 6,
  };
}

/** Send SSE event to all listeners for a job */
function emitProgress(jobId, data) {
  const clients = sseClients.get(jobId) || [];
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => {
    try {
      res.write(payload);
    } catch {
      /* client disconnected */
    }
  });
  // Also update job record
  const job = jobs.get(jobId);
  if (job) Object.assign(job, data);
}

/** Count pages in a PDF */
async function countPdfPages(filePath) {
  const bytes = fs.readFileSync(filePath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
}

/**
 * Intelligent page image cleaning pipeline.
 *
 * Key insight: NOT simple binary thresholding. Instead we:
 *   1. Detect whether the page is dark-background or light-background
 *   2. If dark → negate to flip bg/fg, then clean up
 *   3. Use histogram-based levels to push background → pure white
 *   4. Preserve grayscale tones in text (gray headings stay gray, bold text stays black)
 *   5. Denoise + sharpen for crisp, print-ready output
 *
 * This produces output like a clean professional scan: white pages, sharp text,
 * natural grayscale tones — NOT a harsh binary black/white inversion.
 */
async function processPageImage(inputPath, profile) {
  const metadata = await sharp(inputPath).metadata();
  const { width, height } = metadata;

  // ── Step 1: Grayscale raw pixels for brightness analysis ──
  const grayBuf = await sharp(inputPath).grayscale().raw().toBuffer();

  let totalBrightness = 0;
  for (let i = 0; i < grayBuf.length; i++) totalBrightness += grayBuf[i];
  const avgBrightness = totalBrightness / grayBuf.length;

  // Page is "dark" if average brightness < 128
  const needsInversion = avgBrightness < 128;

  // ── Step 2: Build pipeline — grayscale → (negate if dark) → denoise → normalize ──
  let pipeline = sharp(inputPath).grayscale();

  if (needsInversion) {
    pipeline = pipeline.negate({ alpha: false });
  }

  // Light median filter removes speckle noise before level adjustment
  pipeline = pipeline.median(3);

  // Normalize stretches the histogram to use full 0-255 range
  pipeline = pipeline.normalize();

  const processedBuf = await pipeline.raw().toBuffer();

  // ── Step 3: Histogram-based white-point detection ──
  const histogram = new Uint32Array(256);
  for (let i = 0; i < processedBuf.length; i++) {
    histogram[processedBuf[i]]++;
  }

  // Find the 80th-percentile brightness — everything at or above this is background
  const pixelCount = processedBuf.length;
  let cumulative = 0;
  let bgLevel = 200;
  for (let v = 0; v < 256; v++) {
    cumulative += histogram[v];
    if (cumulative >= pixelCount * 0.8) {
      bgLevel = v;
      break;
    }
  }
  // Safety clamp: bgLevel should never be too low (would erase content)
  bgLevel = Math.max(bgLevel, 150);

  // ── Step 4: Levels adjustment — push background → #FFFFFF, keep text tones ──
  const outputBuf = Buffer.alloc(width * height);

  for (let i = 0; i < processedBuf.length; i++) {
    const px = processedBuf[i];
    if (px >= bgLevel) {
      // Background → pure white
      outputBuf[i] = 255;
    } else {
      // Content: proportionally scale [0 .. bgLevel) → [0 .. 235]
      // This preserves gray headings, semi-bold text, etc.
      outputBuf[i] = Math.min(255, Math.round((px / bgLevel) * 235));
    }
  }

  // ── Step 5: Reconstruct with gentle sharpening for crisp text ──
  const processedBuffer = await sharp(outputBuf, {
    raw: { width, height, channels: 1 },
  })
    .withMetadata({ density: profile.ocrDpi })
    .sharpen({ sigma: profile.sharpenSigma })
    .png({ compressionLevel: profile.pngCompressionLevel })
    .toBuffer();

  return {
    imageBuffer: processedBuffer,
    width,
    height,
  };
}

async function extractOcrWords(worker, imageBuffer) {
  const result = await worker.recognize(imageBuffer);
  const words = result?.data?.words || [];

  return words
    .map((word) => ({
      text: String(word.text || "")
        .replace(/\s+/g, " ")
        .trim(),
      bbox: word.bbox,
    }))
    .filter((word) => word.text && word.bbox);
}

function drawOcrTextLayer(page, ocrWords, placement, sourceSize, font) {
  if (!ocrWords || ocrWords.length === 0) {
    return;
  }

  const scaleX = placement.width / sourceSize.width;
  const scaleY = placement.height / sourceSize.height;

  for (const word of ocrWords) {
    const { text, bbox } = word;
    const bboxWidth = Math.max((bbox.x1 - bbox.x0) * scaleX, 1);
    const bboxHeight = Math.max((bbox.y1 - bbox.y0) * scaleY, 1);
    const x = placement.x + bbox.x0 * scaleX;
    const y = placement.y + (sourceSize.height - bbox.y1) * scaleY;

    let fontSize = Math.max(bboxHeight * 0.9, 1);
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    if (textWidth > bboxWidth && textWidth > 0) {
      fontSize *= bboxWidth / textWidth;
    }

    page.drawText(text, {
      x,
      y,
      size: Math.max(fontSize, 1),
      font,
      color: rgb(0, 0, 0),
      opacity: 0.001,
    });
  }
}

function getLayoutConfig(pagesPerSheet) {
  if (pagesPerSheet === 2) {
    return { columns: 1, rows: 2 };
  }

  if (pagesPerSheet === 4) {
    return { columns: 2, rows: 2 };
  }

  if (pagesPerSheet === 6) {
    return { columns: 2, rows: 3 };
  }

  return { columns: 1, rows: 1 };
}

async function buildOutputPdf(processedImages, pagesPerSheet) {
  const pdfDoc = await PDFDocument.create();
  const embeddedImages = [];
  const ocrFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const processedPage of processedImages) {
    embeddedImages.push({
      ...processedPage,
      embeddedImage: await pdfDoc.embedPng(processedPage.imageBuffer),
    });
  }

  if (embeddedImages.length === 0) {
    throw new Error("No processed pages available to build the output PDF.");
  }

  const firstImage = embeddedImages[0].embeddedImage;
  const sheetWidth = firstImage.width;
  const sheetHeight = firstImage.height;

  if (pagesPerSheet === 1) {
    for (const pageData of embeddedImages) {
      const { embeddedImage, width, height, ocrWords } = pageData;
      const page = pdfDoc.addPage([embeddedImage.width, embeddedImage.height]);
      page.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width: embeddedImage.width,
        height: embeddedImage.height,
      });
      drawOcrTextLayer(
        page,
        ocrWords,
        {
          x: 0,
          y: 0,
          width: embeddedImage.width,
          height: embeddedImage.height,
        },
        { width, height },
        ocrFont,
      );
    }

    return {
      pdfBytes: await pdfDoc.save(),
      outputPages: embeddedImages.length,
    };
  }

  const { columns, rows } = getLayoutConfig(pagesPerSheet);
  const gap = Math.max(
    Math.round(Math.min(sheetWidth, sheetHeight) * 0.025),
    12,
  );
  const cellWidth = (sheetWidth - gap * (columns + 1)) / columns;
  const cellHeight = (sheetHeight - gap * (rows + 1)) / rows;

  for (let start = 0; start < embeddedImages.length; start += pagesPerSheet) {
    const page = pdfDoc.addPage([sheetWidth, sheetHeight]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: sheetWidth,
      height: sheetHeight,
      color: rgb(1, 1, 1),
    });

    for (let slot = 0; slot < pagesPerSheet; slot++) {
      const pageData = embeddedImages[start + slot];
      if (!pageData) {
        break;
      }

      const { embeddedImage, width, height, ocrWords } = pageData;

      const column = slot % columns;
      const row = Math.floor(slot / columns);
      const scale = Math.min(
        cellWidth / embeddedImage.width,
        cellHeight / embeddedImage.height,
      );
      const drawWidth = embeddedImage.width * scale;
      const drawHeight = embeddedImage.height * scale;
      const x = gap + column * (cellWidth + gap) + (cellWidth - drawWidth) / 2;
      const top =
        gap + row * (cellHeight + gap) + (cellHeight - drawHeight) / 2;
      const y = sheetHeight - top - drawHeight;

      page.drawImage(embeddedImage, {
        x,
        y,
        width: drawWidth,
        height: drawHeight,
      });

      drawOcrTextLayer(
        page,
        ocrWords,
        {
          x,
          y,
          width: drawWidth,
          height: drawHeight,
        },
        { width, height },
        ocrFont,
      );
    }
  }

  return {
    pdfBytes: await pdfDoc.save(),
    outputPages: Math.ceil(embeddedImages.length / pagesPerSheet),
  };
}

/** Main PDF conversion pipeline */
async function convertPdf(
  jobId,
  inputPath,
  originalName,
  pagesPerSheet = 1,
  keptPages = null,
  mode = "standard",
) {
  const job = jobs.get(jobId);
  const jobImageDir = path.join(DIRS.images, jobId);
  fs.mkdirSync(jobImageDir, { recursive: true });
  const profile = getProcessingProfile(mode);
  let ocrWorker = null;

  try {
    // Count pages
    const totalPages = await countPdfPages(inputPath);

    if (totalPages > 200) {
      emitProgress(jobId, {
        status: "error",
        message: "PDF exceeds 200 page limit.",
      });
      return;
    }

    job.totalPages = totalPages;
    job.originalSize = fs.statSync(inputPath).size;
    emitProgress(jobId, {
      status: "processing",
      page: 0,
      total: totalPages,
      percentage: 0,
    });

    // Convert PDF to images using pdf-poppler (300 DPI)
    emitProgress(jobId, {
      status: "extracting",
      message: "Extracting pages from PDF...",
      page: 0,
      total: totalPages,
      percentage: 2,
    });

    const popplerOpts = {
      format: "png",
      out_dir: jobImageDir,
      out_prefix: "page",
      scale: profile.popplerScale,
    };

    const popplerClient = ensurePopplerAvailable();
    await popplerClient.convert(inputPath, popplerOpts);

    // Gather extracted page images and sort them
    const pageFiles = fs
      .readdirSync(jobImageDir)
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort((a, b) => {
        const numA = parseInt(a.match(/(\d+)/)?.[1] || "0", 10);
        const numB = parseInt(b.match(/(\d+)/)?.[1] || "0", 10);
        return numA - numB;
      });

    if (pageFiles.length === 0) {
      emitProgress(jobId, {
        status: "error",
        message: "Failed to extract pages from PDF.",
      });
      return;
    }

    const selectedPageFiles =
      Array.isArray(keptPages) && keptPages.length > 0
        ? keptPages
            .map((pageNumber) => pageFiles[pageNumber - 1])
            .filter(Boolean)
        : pageFiles;

    if (selectedPageFiles.length === 0) {
      emitProgress(jobId, {
        status: "error",
        message: "No pages selected for conversion.",
      });
      return;
    }

    // Process each page through the image pipeline
    const processedImages = [];
    const startTime = Date.now();
    const createOcrWorker = ensureOcrAvailable();
    ocrWorker = await createOcrWorker("eng");
    await ocrWorker.setParameters({
      user_defined_dpi: String(profile.ocrDpi),
    });

    for (let i = 0; i < selectedPageFiles.length; i++) {
      const pageFilePath = path.join(jobImageDir, selectedPageFiles[i]);
      const elapsed = Date.now() - startTime;
      const avgPerPage = i > 0 ? elapsed / i : 0;
      const remaining = Math.round(
        (avgPerPage * (selectedPageFiles.length - i)) / 1000,
      );

      emitProgress(jobId, {
        status: "processing",
        page: i + 1,
        total: selectedPageFiles.length,
        percentage: Math.round(((i + 1) / selectedPageFiles.length) * 90) + 5,
        eta: remaining,
        message: `Processing and OCR page ${i + 1} of ${selectedPageFiles.length} (${profile.mode})`,
      });

      const processedPage = await processPageImage(pageFilePath, profile);
      processedPage.ocrWords = await extractOcrWords(
        ocrWorker,
        processedPage.imageBuffer,
      );
      processedImages.push(processedPage);

      // Cleanup source page image immediately
      try {
        fs.unlinkSync(pageFilePath);
      } catch {
        /* ignore */
      }
    }

    // Reassemble into PDF
    emitProgress(jobId, {
      status: "assembling",
      message: "Assembling final PDF...",
      percentage: 95,
    });

    const { pdfBytes, outputPages } = await buildOutputPdf(
      processedImages,
      pagesPerSheet,
    );
    const downloadName = buildDownloadFileName(originalName);
    const outputName = `${uuidv4()}-${downloadName}`;
    const outputPath = path.join(DIRS.processed, outputName);
    fs.writeFileSync(outputPath, pdfBytes);

    const processedSize = fs.statSync(outputPath).size;
    const duration = Math.round((Date.now() - startTime) / 1000);

    job.status = "complete";
    job.outputFile = outputName;
    job.downloadName = downloadName;
    job.processedSize = processedSize;
    job.duration = duration;

    emitProgress(jobId, {
      status: "complete",
      percentage: 100,
      outputFile: outputName,
      downloadName,
      originalSize: job.originalSize,
      processedSize,
      totalPages: selectedPageFiles.length,
      originalPageCount: pageFiles.length,
      selectedPages: selectedPageFiles.length,
      outputPages,
      layout: pagesPerSheet,
      mode: profile.mode,
      duration,
      message: "Conversion complete!",
    });
  } catch (err) {
    console.error(`[Job ${jobId}] Error:`, err);
    emitProgress(jobId, {
      status: "error",
      message: err.message || "An unexpected error occurred during processing.",
    });
  } finally {
    if (ocrWorker) {
      try {
        await ocrWorker.terminate();
      } catch {
        /* ignore */
      }
    }
    // Cleanup source PDF and temp image directory
    try {
      fs.unlinkSync(inputPath);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(jobImageDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ─── Routes ────────────────────────────────────────────────────────

/** POST /upload — Accept and validate PDF */
app.post("/upload", (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res
          .status(413)
          .json({ error: "File too large. Maximum size is 50 MB." });
      }
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    // Validate magic bytes
    if (!validatePdfMagic(req.file.path)) {
      fs.unlinkSync(req.file.path);
      return res
        .status(400)
        .json({ error: "Invalid file. The uploaded file is not a valid PDF." });
    }

    // Count pages
    let pageCount;
    try {
      pageCount = await countPdfPages(req.file.path);
    } catch {
      fs.unlinkSync(req.file.path);
      return res
        .status(400)
        .json({ error: "Corrupted or unreadable PDF file." });
    }

    if (pageCount > 200) {
      fs.unlinkSync(req.file.path);
      return res
        .status(400)
        .json({ error: `PDF has ${pageCount} pages. Maximum is 200.` });
    }

    const fileId = uuidv4();
    jobs.set(fileId, {
      status: "uploaded",
      filePath: req.file.path,
      originalName: req.file.originalname,
      originalSize: req.file.size,
      pageCount,
      uploadedAt: Date.now(),
    });

    res.json({
      fileId,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      pageCount,
      message: "Upload successful. Ready to convert.",
    });
  });
});

/** POST /convert — Start conversion */
app.post("/convert", convertLimiter, (req, res) => {
  const { fileId, layout, keptPages, mode } = req.body;
  if (!fileId || !jobs.has(fileId)) {
    return res.status(400).json({ error: "Invalid or expired file ID." });
  }

  if (!poppler) {
    return res.status(503).json({
      error: "PDF conversion is currently unavailable because the conversion engine could not start.",
    });
  }

  if (!createWorker) {
    return res.status(503).json({
      error:
        "PDF conversion is currently unavailable because the OCR engine could not start.",
    });
  }

  const pagesPerSheet = Number(layout || 1);
  if (![1, 2, 4, 6].includes(pagesPerSheet)) {
    return res
      .status(400)
      .json({ error: "Invalid layout. Supported values are 1, 2, 4, and 6." });
  }

  const processingMode = mode === "fast" ? "fast" : "standard";

  const job = jobs.get(fileId);
  if (job.status !== "uploaded") {
    return res
      .status(400)
      .json({
        error: "This file is already being processed or has been processed.",
      });
  }

  const normalizedKeptPages = Array.isArray(keptPages)
    ? [
        ...new Set(
          keptPages
            .map((page) => Number(page))
            .filter(
              (page) =>
                Number.isInteger(page) && page >= 1 && page <= job.pageCount,
            ),
        ),
      ].sort((a, b) => a - b)
    : null;

  if (normalizedKeptPages && normalizedKeptPages.length === 0) {
    return res
      .status(400)
      .json({ error: "Select at least one page before conversion." });
  }

  job.status = "processing";
  job.layout = pagesPerSheet;
  job.keptPages = normalizedKeptPages;
  job.mode = processingMode;
  const jobId = fileId;

  // Fire and forget the conversion
  convertPdf(
    jobId,
    job.filePath,
    job.originalName,
    pagesPerSheet,
    normalizedKeptPages,
    processingMode,
  );

  res.json({
    jobId,
    layout: pagesPerSheet,
    mode: processingMode,
    message: "Conversion started.",
  });
});

/** GET /progress/:jobId — SSE endpoint for live progress */
app.get("/progress/:jobId", (req, res) => {
  const { jobId } = req.params;
  if (!jobs.has(jobId)) {
    return res.status(404).json({ error: "Job not found." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Register this client
  if (!sseClients.has(jobId)) sseClients.set(jobId, []);
  sseClients.get(jobId).push(res);

  // Send current state immediately
  const job = jobs.get(jobId);
  res.write(`data: ${JSON.stringify(job)}\n\n`);

  // Cleanup on disconnect
  req.on("close", () => {
    const clients = sseClients.get(jobId) || [];
    sseClients.set(
      jobId,
      clients.filter((c) => c !== res),
    );
  });
});

/** GET /download/:filename — Serve processed PDF */
app.get("/download/:filename", (req, res) => {
  // Sanitize: prevent directory traversal
  const filename = path.basename(req.params.filename);
  const filePath = path.join(DIRS.processed, filename);

  if (!fs.existsSync(filePath)) {
    return res
      .status(404)
      .json({ error: "File not found or already downloaded." });
  }

  const matchedJob = Array.from(jobs.values()).find(
    (job) => job.outputFile === filename,
  );
  const downloadName = matchedJob?.downloadName || "converted.pdf";

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${downloadName}"`,
  );

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  stream.on("end", () => {
    // Cleanup after download
    setTimeout(() => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
    }, 5000);
  });
});

// ─── Automatic Temp Cleanup (every 30 minutes) ────────────────────
function cleanupTempFiles() {
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();

  // Clean uploads
  for (const dir of [DIRS.uploads, DIRS.processed]) {
    try {
      for (const file of fs.readdirSync(dir)) {
        const fp = path.join(dir, file);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > ONE_HOUR) {
            fs.unlinkSync(fp);
            console.log(`[Cleanup] Removed: ${fp}`);
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Clean image subdirectories
  try {
    for (const sub of fs.readdirSync(DIRS.images)) {
      const subPath = path.join(DIRS.images, sub);
      try {
        const stat = fs.statSync(subPath);
        if (now - stat.mtimeMs > ONE_HOUR) {
          fs.rmSync(subPath, { recursive: true, force: true });
          console.log(`[Cleanup] Removed dir: ${subPath}`);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  // Clean expired jobs from memory
  for (const [id, job] of jobs.entries()) {
    if (now - (job.uploadedAt || 0) > ONE_HOUR) {
      jobs.delete(id);
      sseClients.delete(id);
    }
  }
}

setInterval(cleanupTempFiles, 30 * 60 * 1000);

// ─── Error handler ─────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("[Server Error]", err);
  res.status(500).json({ error: "Internal server error. Please try again." });
});

// ─── Start Server ──────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║   PDF Background Converter                   ║
║   Running on http://localhost:${PORT}           ║
║   Ready to process dark PDFs → white PDFs    ║
╚══════════════════════════════════════════════╝
  `);
  });
}

module.exports = app;
