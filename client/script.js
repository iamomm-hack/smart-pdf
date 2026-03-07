/* ═══════════════════════════════════════════════════════════
   PDF Background Converter — Client Logic
   Handles upload, SSE progress, and download flow
   ═══════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  // ─── DOM Refs ──────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const dropZone = $("#drop-zone");
  const fileInput = $("#file-input");
  const fileInfo = $("#file-info");
  const fileName = $("#file-name");
  const fileSize = $("#file-size");
  const filePages = $("#file-pages");
  const fileStatus = $("#file-status");
  const pageEditor = $("#page-editor");
  const pageEditorList = $("#page-editor-list");
  const pageEditorSummary = $("#page-editor-summary");
  const btnResetPages = $("#btn-reset-pages");
  const layoutSelector = $("#layout-selector");
  const layoutInputs = document.querySelectorAll('input[name="layout-mode"]');
  const processingModeSelector = $("#processing-mode-selector");
  const processingModeInputs = document.querySelectorAll(
    'input[name="processing-mode"]',
  );
  const btnConvert = $("#btn-convert");
  const btnClear = $("#btn-clear");
  const errorBar = $("#error-bar");
  const errorMsg = $("#error-msg");
  const errorClose = $("#error-close");

  const sectionUpload = $("#section-upload");
  const sectionProcessing = $("#section-processing");
  const sectionDownload = $("#section-download");

  const progressCircle = $("#progress-circle");
  const progressPct = $("#progress-pct");
  const processingStatus = $("#processing-status");
  const processingPage = $("#processing-page");
  const processingEta = $("#processing-eta");
  const processingLog = $("#processing-log");

  const statOriginal = $("#stat-original");
  const statConverted = $("#stat-converted");
  const statPages = $("#stat-pages");
  const statOutputPages = $("#stat-output-pages");
  const statLayout = $("#stat-layout");
  const statTime = $("#stat-time");
  const btnDownload = $("#btn-download");
  const btnAnother = $("#btn-another");

  const footerStatus = $("#footer-status");

  // ─── State ─────────────────────────────────────────────
  let currentFileId = null;
  let eventSource = null;
  let selectedFile = null;
  let totalUploadedPages = 0;
  let selectedPages = [];

  // ─── Utilities ─────────────────────────────────────────
  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
  }

  function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }

  function getSelectedLayout() {
    const selected = Array.from(layoutInputs).find((input) => input.checked);
    return selected ? Number(selected.value) : 1;
  }

  function getSelectedProcessingMode() {
    const selected = Array.from(processingModeInputs).find(
      (input) => input.checked,
    );
    return selected ? selected.value : "standard";
  }

  function getKeptPages() {
    return selectedPages.slice();
  }

  function updatePageEditorSummary() {
    if (!pageEditorSummary) return;
    const keptCount = selectedPages.length;
    const removedCount = Math.max(totalUploadedPages - keptCount, 0);
    pageEditorSummary.textContent =
      removedCount > 0
        ? `Keeping ${keptCount} pages, removed ${removedCount}.`
        : `Keeping all ${keptCount} pages.`;
    filePages.textContent =
      totalUploadedPages > 0 ? `${keptCount}/${totalUploadedPages}` : "—";
  }

  function renderPageEditor() {
    if (!pageEditorList) return;
    pageEditorList.innerHTML = "";

    for (let pageNumber = 1; pageNumber <= totalUploadedPages; pageNumber++) {
      const isActive = selectedPages.includes(pageNumber);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `page-chip${isActive ? "" : " page-chip--removed"}`;
      button.dataset.pageNumber = String(pageNumber);
      button.setAttribute("aria-pressed", String(isActive));
      button.innerHTML = `
        <span class="page-chip__number">PAGE ${pageNumber}</span>
        <span class="page-chip__state">${isActive ? "KEEP" : "REMOVED"}</span>
      `;
      pageEditorList.appendChild(button);
    }

    updatePageEditorSummary();
  }

  function initializePageEditor(pageCount) {
    totalUploadedPages = pageCount;
    selectedPages = Array.from({ length: pageCount }, (_, index) => index + 1);
    renderPageEditor();
    pageEditor.hidden = false;
    layoutSelector.hidden = false;
    processingModeSelector.hidden = false;
  }

  function togglePageSelection(pageNumber) {
    const isSelected = selectedPages.includes(pageNumber);

    if (isSelected && selectedPages.length === 1) {
      showError("At least one page must remain in the PDF.");
      return;
    }

    if (isSelected) {
      selectedPages = selectedPages.filter((page) => page !== pageNumber);
    } else {
      selectedPages = [...selectedPages, pageNumber].sort((a, b) => a - b);
    }

    hideError();
    renderPageEditor();
    btnConvert.disabled = !currentFileId || selectedPages.length === 0;
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorBar.hidden = false;
  }

  function hideError() {
    errorBar.hidden = true;
  }

  function showSection(section) {
    [sectionUpload, sectionProcessing, sectionDownload].forEach((s) => {
      s.hidden = true;
      s.classList.remove("section--active");
    });
    section.hidden = false;
    section.classList.add("section--active");
  }

  function setHeaderStatus(text, ok = true) {
    if (footerStatus) {
      footerStatus.textContent = ok ? "OPERATIONAL" : text;
      footerStatus.style.color = ok ? "var(--clr-accent)" : "var(--clr-warn)";
    }
  }

  function addLogEntry(text, type = "") {
    const div = document.createElement("div");
    div.className = "log-entry" + (type ? ` log-entry--${type}` : "");
    div.textContent = `> ${text}`;
    processingLog.appendChild(div);
    processingLog.scrollTop = processingLog.scrollHeight;
  }

  function resetProcessingUI() {
    processingLog.innerHTML =
      '<div class="log-entry">> Starting conversion pipeline...</div>';
    setProgress(0);
    processingStatus.textContent = "Initializing...";
    processingPage.textContent = "Page 0 / 0";
    processingEta.textContent = "Estimating time...";
  }

  // Circle progress: circumference = 2 * PI * 54 = 339.292
  const CIRCUMFERENCE = 339.292;

  function setProgress(pct) {
    const offset = CIRCUMFERENCE - (pct / 100) * CIRCUMFERENCE;
    progressCircle.style.strokeDashoffset = offset;
    progressPct.textContent = `${Math.round(pct)}%`;
  }

  // ─── Drag & Drop ──────────────────────────────────────
  let dragCounter = 0;

  dropZone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    dropZone.classList.add("drop-zone--drag");
  });

  dropZone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropZone.classList.remove("drop-zone--drag");
    }
  });

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.remove("drop-zone--drag");

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileSelect(files[0]);
    }
  });

  dropZone.addEventListener("click", () => fileInput.click());

  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
      handleFileSelect(fileInput.files[0]);
    }
  });

  // ─── File Selection ───────────────────────────────────
  function handleFileSelect(file) {
    hideError();

    // Client-side validation
    if (
      !file.name.toLowerCase().endsWith(".pdf") &&
      file.type !== "application/pdf"
    ) {
      showError("Please select a valid PDF file.");
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      showError("File is too large. Maximum size is 50 MB.");
      return;
    }

    selectedFile = file;
    uploadFile(file);
  }

  // ─── Upload ───────────────────────────────────────────
  async function uploadFile(file) {
    hideError();
    btnConvert.disabled = true;

    setHeaderStatus("UPLOADING...", true);
    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);
    filePages.textContent = "...";
    fileStatus.textContent = "UPLOADING";
    fileStatus.className = "file-info__value";
    fileInfo.hidden = false;

    const formData = new FormData();
    formData.append("pdf", file);

    try {
      const res = await fetch("/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Upload failed.");
      }

      currentFileId = data.fileId;
      filePages.textContent = data.pageCount;
      fileStatus.textContent = "READY";
      fileStatus.className = "file-info__value file-info__value--ok";
      btnConvert.disabled = false;
      btnClear.hidden = false;
      initializePageEditor(data.pageCount);
      setHeaderStatus("FILE LOADED", true);
    } catch (err) {
      showError(err.message || "Upload failed. Please try again.");
      fileStatus.textContent = "ERROR";
      fileStatus.style.color = "var(--clr-error)";
      setHeaderStatus("UPLOAD ERROR", false);
    }
  }

  // ─── Convert ──────────────────────────────────────────
  btnConvert.addEventListener("click", async () => {
    if (!currentFileId) return;
    hideError();

    btnConvert.disabled = true;
    const btnText = btnConvert.querySelector(".btn__text");
    const btnLoader = btnConvert.querySelector(".btn__loader");
    btnText.textContent = "STARTING...";
    btnLoader.hidden = false;

    try {
      const res = await fetch("/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: currentFileId,
          layout: getSelectedLayout(),
          mode: getSelectedProcessingMode(),
          keptPages: getKeptPages(),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Conversion failed to start.");
      }

      // Switch to processing view
      resetProcessingUI();
      showSection(sectionProcessing);
      setHeaderStatus("PROCESSING", true);

      // Open SSE for progress
      listenForProgress(data.jobId);
    } catch (err) {
      showError(err.message || "Failed to start conversion.");
      btnText.textContent = "INITIATE CONVERSION →";
      btnLoader.hidden = true;
      btnConvert.disabled = false;
      setHeaderStatus("ERROR", false);
    }
  });

  // ─── SSE Progress ─────────────────────────────────────
  function listenForProgress(jobId) {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource(`/progress/${jobId}`);

    eventSource.onmessage = (evt) => {
      let data;
      try {
        data = JSON.parse(evt.data);
      } catch {
        return;
      }

      if (data.status === "extracting") {
        processingStatus.textContent = "EXTRACTING PAGES";
        processingPage.textContent = `Page ${data.page || 0} / ${data.total || 0}`;
        if (data.eta !== undefined) {
          processingEta.textContent =
            data.eta > 0
              ? `~${formatDuration(data.eta)} remaining`
              : "Almost done...";
        }
        addLogEntry(data.message || "Extracting pages from PDF...");
        setProgress(data.percentage || 2);
      }

      if (data.status === "processing") {
        const pct = data.percentage || 0;
        setProgress(pct);
        processingStatus.textContent = "PROCESSING";
        processingPage.textContent = `Page ${data.page || 0} / ${data.total || 0}`;
        if (data.eta !== undefined) {
          processingEta.textContent =
            data.eta > 0
              ? `~${formatDuration(data.eta)} remaining`
              : "Almost done...";
        }
        if (data.page) {
          addLogEntry(`Page ${data.page}/${data.total} processed`);
        }
      }

      if (data.status === "assembling") {
        processingStatus.textContent = "ASSEMBLING PDF";
        setProgress(95);
        addLogEntry("Assembling final PDF document...");
      }

      if (data.status === "complete") {
        setProgress(100);
        processingStatus.textContent = "COMPLETE";
        addLogEntry("Conversion complete!", "accent");
        if (eventSource) eventSource.close();

        // Transition to download section
        setTimeout(() => showDownloadSection(data), 600);
      }

      if (data.status === "error") {
        if (eventSource) eventSource.close();
        addLogEntry(data.message || "An error occurred.", "error");
        setHeaderStatus("ERROR", false);
        processingStatus.textContent = "ERROR";

        // Go back to upload with error
        setTimeout(() => {
          showSection(sectionUpload);
          reset();
          showError(data.message || "Processing error. Please try again.");
        }, 2000);
      }
    };

    eventSource.onerror = () => {
      if (eventSource) eventSource.close();
    };
  }

  // ─── Download Section ─────────────────────────────────
  function showDownloadSection(data) {
    setHeaderStatus("COMPLETE", true);
    showSection(sectionDownload);

    statOriginal.textContent = formatBytes(data.originalSize || 0);
    statConverted.textContent = formatBytes(data.processedSize || 0);
    if (data.originalPageCount && data.selectedPages) {
      statPages.textContent = `${data.selectedPages}/${data.originalPageCount}`;
    } else {
      statPages.textContent = data.totalPages || "—";
    }
    statOutputPages.textContent = data.outputPages || "—";
    statLayout.textContent = `${data.layout || 1}-UP`;
    statTime.textContent = data.duration ? formatDuration(data.duration) : "—";

    btnDownload.href = `/download/${data.outputFile}`;
  }

  // ─── Clear / Reset ───────────────────────────────────
  function reset() {
    currentFileId = null;
    selectedFile = null;
    totalUploadedPages = 0;
    selectedPages = [];
    fileInput.value = "";
    fileInfo.hidden = true;
    pageEditor.hidden = true;
    layoutSelector.hidden = true;
    processingModeSelector.hidden = true;
    pageEditorList.innerHTML = "";
    hideError();

    const btnText = btnConvert.querySelector(".btn__text");
    const btnLoader = btnConvert.querySelector(".btn__loader");
    btnText.textContent = "INITIATE CONVERSION →";
    btnLoader.hidden = true;
    btnConvert.disabled = true;
    btnClear.hidden = true;
    layoutInputs.forEach((input) => {
      input.checked = input.value === "1";
    });
    processingModeInputs.forEach((input) => {
      input.checked = input.value === "standard";
    });

    setHeaderStatus("SYSTEM READY", true);
  }

  btnClear.addEventListener("click", () => {
    reset();
  });

  pageEditorList.addEventListener("click", (event) => {
    const button = event.target.closest(".page-chip");
    if (!button) return;
    const pageNumber = Number(button.dataset.pageNumber);
    if (!pageNumber) return;
    togglePageSelection(pageNumber);
  });

  btnResetPages.addEventListener("click", () => {
    if (!totalUploadedPages) return;
    selectedPages = Array.from(
      { length: totalUploadedPages },
      (_, index) => index + 1,
    );
    hideError();
    renderPageEditor();
    btnConvert.disabled = !currentFileId;
  });

  btnAnother.addEventListener("click", () => {
    reset();
    showSection(sectionUpload);
  });

  errorClose.addEventListener("click", hideError);

  // ─── Prevent default file drag on window ──────────────
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
})();
