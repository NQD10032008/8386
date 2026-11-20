// --- 1. TỪ ĐIỂN SỬA LỖI PHỔ BIẾN & LƯU LOCALSTORAGE ---
const OCR_FIXES_STORAGE_KEY = "AI_IMAGE_TO_TEXT_COMMON_FIXES_V1";

const DEFAULT_OCR_FIXES = [
  ["hoá đơn", "hóa đơn"],
  ["tổng công", "tổng cộng"],
  ["tông cộng", "tổng cộng"],
  ["thành tiên", "thành tiền"],
  ["thanh toan", "thanh toán"],
  ["sô lượng", "số lượng"],
  ["đơn giá", "đơn giá"],
  ["nhân dang", "nhận dạng"],
  ["văn bản", "văn bản"],
  ["hinh ảnh", "hình ảnh"],
  ["giây trươc", "giây trước"],
  ["phút trươc", "phút trước"],
  ["giờ trươc", "giờ trước"],
  ["xử lí", "xử lý"],
  ["chủ đồ", "chủ đề"],
  ["ké hoạch", "kế hoạch"],
  ["kĩ năng", "kỹ năng"],
  ["tiên mặt", "tiền mặt"],
  ["chuyên khoản", "chuyển khoản"],
  ["thuê vat", "thuế VAT"],
  ["mã sô thuê", "mã số thuế"],
];

function loadCommonOcrFixes(defaultMap) {
  try {
    const raw = localStorage.getItem(OCR_FIXES_STORAGE_KEY);
    if (!raw) return new Map(defaultMap);
    const entries = JSON.parse(raw);
    return Array.isArray(entries) ? new Map(entries) : new Map(defaultMap);
  } catch {
    return new Map(defaultMap);
  }
}

function saveCommonOcrFixes(fixesMap) {
  try {
    localStorage.setItem(
      OCR_FIXES_STORAGE_KEY,
      JSON.stringify([...fixesMap.entries()])
    );
  } catch (err) {
    console.warn("Không lưu được từ điển vào localStorage:", err);
  }
}

const COMMON_OCR_FIXES = loadCommonOcrFixes(DEFAULT_OCR_FIXES);

// --- 2. TIỀN XỬ LÝ ẢNH CHO NHIỀU GÓC ĐỘ / ÁNH SÁNG ---
function preprocessImageForAngleAndLighting(fileOrBlob) {
  return new Promise((resolve) => {
    if (!fileOrBlob) {
      resolve(fileOrBlob);
      return;
    }

    const img = new Image();
    const objectUrl = URL.createObjectURL(fileOrBlob);

    img.onload = () => {
      try {
        const minSide = Math.min(img.width || 0, img.height || 0);
        const maxSide = Math.max(img.width || 0, img.height || 0);

        if (!minSide || !maxSide) {
          URL.revokeObjectURL(objectUrl);
          resolve(fileOrBlob);
          return;
        }

        let scale = 1;
        if (minSide < 900) {
          scale = Math.min(2.2, 1200 / minSide);
        } else if (maxSide > 2600) {
          scale = 2600 / maxSide;
        }

        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });

        if (!ctx) {
          URL.revokeObjectURL(objectUrl);
          resolve(fileOrBlob);
          return;
        }

        ctx.filter = "grayscale(100%) contrast(125%) brightness(104%)";
        ctx.drawImage(img, 0, 0, width, height);
        ctx.filter = "none";

        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;

        let minLum = 255;
        let maxLum = 0;
        for (let i = 0; i < data.length; i += 4) {
          const lum = data[i];
          if (lum < minLum) minLum = lum;
          if (lum > maxLum) maxLum = lum;
        }

        const range = maxLum - minLum;
        if (range > 40 && (minLum > 15 || maxLum < 240)) {
          const factor = 255 / range;
          for (let i = 0; i < data.length; i += 4) {
            const stretched = Math.max(
              0,
              Math.min(255, (data[i] - minLum) * factor)
            );
            data[i] = stretched;
            data[i + 1] = stretched;
            data[i + 2] = stretched;
          }
          ctx.putImageData(imageData, 0, 0);
        }

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(objectUrl);
            resolve(blob || fileOrBlob);
          },
          "image/png",
          0.95
        );
      } catch (err) {
        console.warn("Tiền xử lý ảnh gặp lỗi, dùng ảnh gốc:", err);
        URL.revokeObjectURL(objectUrl);
        resolve(fileOrBlob);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(fileOrBlob);
    };

    img.src = objectUrl;
  });
}

// --- 3. LỌC KÝ TỰ THỪA, NHIỄU, TÁCH DÍNH CHỮ & XỬ LÝ HÓA ĐƠN ---
function removeOcrNoise(rawText) {
  if (!rawText) return "";

  const noisePatterns = [
    /^[=<>~^¬|+\\\-_.*•·°„“”¿¡\[\]{}|/\\]+$/,
    /^\d{1,2}:\d{2,3}\s*[„“”'".,-]*.*$/,
    /^=\s*Gemini\b.*$/i,
    /^:?\s*\d+\s*(giây|phút|giờ|ngày)\s+trước$/i,
    /^(trang|page)\s*\d+(\s*(\/|of|trên)\s*\d+)?$/i,
    /^[A-Z]{2,5}$/,
    /^[a-zA-Z]{1,2}\d+[a-zA-Z0-9\s¬=<>~^-]*$/,
    /^[A-Za-z]\s*`?,?\s*[a-zA-Z0-9]+\s*:?$/,
    /^[N|J|I|l]\s*\d+\s*[:\-–—.,&^~`"' ]+.*$/,
  ];

  return rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => {
      if (!line) return false;
      const meaningfulChars = line.replace(/[^a-zA-Z0-9\u00C0-\u1EF9]/g, "");
      if (meaningfulChars.length < 2) return false;
      if (noisePatterns.some((pattern) => pattern.test(line))) return false;
      if (/[¬=<>~^¿`„“”]/.test(line) && meaningfulChars.length <= 5) {
        return false;
      }
      const tokens = line.split(" ");
      const shortTokens = tokens.filter((t) => t.length <= 2);
      if (tokens.length >= 3 && shortTokens.length === tokens.length) {
        return false;
      }
      const symbolCount = (line.match(/[^a-zA-Z0-9\u00C0-\u1EF9\s]/g) || [])
        .length;
      if (symbolCount >= 4 && meaningfulChars.length <= 6) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function isUpperStart(str) {
  return /^[A-ZÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬĐÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ]/.test(
    str
  );
}

function matchCapitalization(source, target) {
  if (!target) return target;
  if (isUpperStart(source)) {
    return target.charAt(0).toUpperCase() + target.slice(1);
  }
  return target;
}

function splitMergedWords(text) {
  let out = text
    .replace(/\[([^\]]+)\]/g, (_, inner) => {
      const spacedInner = inner
        .replace(
          /([a-zàáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ])([A-ZÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬĐÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ])/g,
          "$1 $2"
        )
        .trim();
      return `[${spacedInner}]`;
    })
    .replace(/\](\S)/g, "] $1")
    .replace(/(\S)\[/g, "$1 [");

  out = out.replace(
    /([\p{Lu}])([\p{Ll}])/gu,
    (match, upper, lower, offset, str) => {
      if (offset === 0) return match;
      const prev = str[offset - 1];
      if (/[\p{L}\p{N}\]]/u.test(prev)) {
        return ` ${upper}${lower}`;
      }
      return match;
    }
  );

  out = out.replace(/([A-Za-zÀ-ỹ]{2,})(\d{1,4})\b/g, "$1 $2");

  const commonGluePairs = [
    ["tênvitrí", "tên vị trí"],
    ["vịtrí", "vị trí"],
    ["chếđộ", "chế độ"],
    ["tấtcả", "tất cả"],
    ["kếtquả", "kết quả"],
    ["khớpchínhxác", "khớp chính xác"],
    ["hìnhảnh", "hình ảnh"],
    ["nhậndạng", "nhận dạng"],
    ["vănbản", "văn bản"],
    ["thựchiện", "thực hiện"],
    ["nhiệmvụ", "nhiệm vụ"],
    ["tìnhhuống", "tình huống"],
    ["trảinghiệm", "trải nghiệm"],
    ["củamình", "của mình"],
    ["củacác", "của các"],
    ["chúngta", "chúng ta"],
    ["hóađơn", "hóa đơn"],
    ["hoáđơn", "hóa đơn"],
    ["tổngcộng", "tổng cộng"],
    ["thànhtiền", "thành tiền"],
    ["sốlượng", "số lượng"],
    ["đơngiá", "đơn giá"],
  ];

  for (const [glued, spaced] of commonGluePairs) {
    const regex = new RegExp(glued, "gi");
    out = out.replace(regex, (m) => matchCapitalization(m, spaced));
  }

  return out;
}

function cleanExcessCharacters(line) {
  let out = line.normalize("NFC").replace(/\s+/g, " ").trim();

  out = out
    .replace(/^[¿¡„“\]|+*~^=<>_•·°]+/, "")
    .replace(/[|+*~^=<>_•·°]+$/, "")
    .trim();

  if (!out) return "";

  out = out
    .replace(/[¬^~`]+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])(?:\s*[.,:;!?])+/g, "$1")
    .replace(/([,.;:!?])(?=[^\s\d"”’)\]])/g, "$1 ")
    .replace(/\s+"$/g, '"')
    .replace(/\s+”$/g, "”")
    .replace(/\s+/g, " ")
    .trim();

  return out;
}

function normalizeInvoiceFormatting(text, mode = "auto") {
  const isInvoice =
    mode === "invoice" ||
    /(hóa đơn|hoá đơn|biên lai|phiếu tính tiền|tổng cộng|thành tiền|số lượng|đơn giá|tiền mặt|chuyển khoản|vat)/i.test(
      text
    );

  if (!isInvoice) return text;

  return text
    .split(/\r?\n/)
    .map((line) => {
      let l = line
        .replace(/(\d[\d.,]*)\s*(vnd|vnđ|đồng)\b/gi, "$1 VNĐ")
        .replace(/(\d[\d.,]*)\s*d(?=\s|$|[.,;:])/g, "$1đ")
        .replace(/\btong\s*cong\b/gi, "Tổng cộng")
        .replace(/\bthanh\s*tien\b/gi, "Thành tiền")
        .replace(/\bso\s*luong\b/gi, "Số lượng")
        .replace(/\bdon\s*gia\b/gi, "Đơn giá");

      l = l.replace(
        /^(Tổng cộng|Thành tiền|Tiền mặt|Chuyển khoản|Thuế VAT|Mã số thuế|Ngày|Giờ)\s*[:.-]?\s*/i,
        (_, label) => `${label.charAt(0).toUpperCase() + label.slice(1)}: `
      );

      return l.trim();
    })
    .join("\n")
    .trim();
}

function fixVietnameseSpellingLine(line) {
  let fixed = cleanExcessCharacters(line);
  if (!fixed) return "";

  fixed = splitMergedWords(fixed);
  fixed = cleanExcessCharacters(fixed);
  if (!fixed) return "";

  fixed = fixed
    .split(" ")
    .map((token) => {
      if (/^\d+([.,]\d+)*$/.test(token) \vert{}\vert{} /^[A-Z0-9_-]{3,}$/.test(token)) {
        return token;
      }
      const lower = token.toLowerCase();
      if (COMMON_OCR_FIXES.has(lower)) {
        return matchCapitalization(token, COMMON_OCR_FIXES.get(lower));
      }
      return token;
    })
    .join(" ");

  for (const [wrongPhrase, rightPhrase] of COMMON_OCR_FIXES.entries()) {
    if (wrongPhrase.includes(" ")) {
      const escaped = wrongPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(
        `(^|[^\\p{L}\\p{N}])(${escaped})(?=[^\\p{L}\\p{N}]|$)`,
        "giu"
      );
      fixed = fixed.replace(regex, (fullMatch, prefix, matchedWord) => {
        return `${prefix}${matchCapitalization(matchedWord, rightPhrase)}`;
      });
    }
  }

  return cleanExcessCharacters(fixed);
}

function joinCrossPageAndWrappedLines(lines) {
  const merged = [];
  for (const line of lines) {
    if (!line) continue;
    if (merged.length === 0) {
      merged.push(line);
      continue;
    }

    const prev = merged[merged.length - 1];
    const endsSentence = /[.!?:;]$/.test(prev);
    const startsNewSection =
      /^(\[|Tiêu đề:|Kính gửi|Chúc|Trân trọng|Tổng cộng|Thành tiền|Tiền mặt|Chuyển khoản|Thuế VAT|Mã số thuế|\d+[.)]\s)/i.test(
        line
      );

    if (!endsSentence && !startsNewSection) {
      merged[merged.length - 1] = `${prev} ${line}`.replace(/\s+/g, " ").trim();
    } else {
      merged.push(line);
    }
  }
  return merged;
}

function postProcessOcrText(rawText, mode = "auto") {
  if (!rawText) return "";
  const cleanedLines = rawText
    .normalize("NFC")
    .split(/\r?\n/)
    .map(fixVietnameseSpellingLine)
    .filter(Boolean);

  const joined = joinCrossPageAndWrappedLines(cleanedLines).join("\n").trim();
  return normalizeInvoiceFormatting(joined, mode);
}

function applyProcessedResult(rawText, mode = "auto") {
  const noNoiseText = removeOcrNoise(rawText);
  return postProcessOcrText(noNoiseText, mode);
}

// --- 4. KHỞI TẠO GIAO DIỆN, CHỌN ẢNH, CAMERA & OCR ---
document.addEventListener("DOMContentLoaded", () => {
  const selectImageBtn = document.getElementById("selectImageBtn");
  const imageInput = document.getElementById("imageInput");
  const dropZone = document.getElementById("dropZone");
  const recognizeBtn = document.getElementById("recognizeBtn");
  const resultText = document.getElementById("resultText");
  const activeCategoryBadge = document.getElementById("activeCategoryBadge");
  const messageBox = document.getElementById("messageBox");
  const progressWrapper = document.getElementById("progressWrapper");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  const copyBtn = document.getElementById("copyBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const clearBtn = document.getElementById("clearBtn");
  const docTypeSelect =
    document.getElementById("docTypeSelect") ||
    document.getElementById("categorySelect");

  const cameraBtn =
    document.getElementById("cameraBtn") ||
    document.getElementById("captureBtn") ||
    Array.from(document.querySelectorAll("button")).find((btn) =>
      /chụp ảnh trực tiếp/i.test(btn.textContent || "")
    );

  let selectedFiles = [];
  let lastOcrOutputSnapshot = "";

  function getDocMode() {
    const val = (docTypeSelect?.value || "").toLowerCase();
    if (
      val.includes("invoice") ||
      val.includes("hoa") ||
      val.includes("hóa")
    ) {
      return "invoice";
    }
    return "auto";
  }

  function setStatus(msg, isError = false) {
    if (!messageBox) return;
    messageBox.textContent = msg;
    messageBox.classList.remove("hidden");
    messageBox.style.color = isError ? "#b91c1c" : "";
  }

  function handleFilesSelected(files) {
    const validFiles = Array.from(files || []).filter(
      (f) => f && f.type && f.type.startsWith("image/")
    );
    if (validFiles.length > 0) {
      selectedFiles = validFiles;
      if (recognizeBtn) recognizeBtn.disabled = false;
      setStatus(
        `Đã chọn ${selectedFiles.length} ảnh: ${selectedFiles
          .map((f) => f.name)
          .join(", ")}`
      );
    } else {
      selectedFiles = [];
      if (recognizeBtn) recognizeBtn.disabled = true;
      setStatus("Vui lòng chọn file ảnh hợp lệ (JPG, PNG, WEBP...).", true);
    }
  }

  if (selectImageBtn && imageInput) {
    selectImageBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      imageInput.value = "";
      imageInput.click();
    });
  }

  if (imageInput) {
    imageInput.addEventListener("change", (e) => {
      handleFilesSelected(e.target?.files);
    });
  }

  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) {
        handleFilesSelected(e.dataTransfer.files);
      }
    });
  }

  const cameraInput = document.createElement("input");
  cameraInput.type = "file";
  cameraInput.accept = "image/*";
  cameraInput.setAttribute("capture", "environment");
  cameraInput.classList.add("hidden");
  document.body.appendChild(cameraInput);

  cameraInput.addEventListener("change", (e) => {
    handleFilesSelected(e.target?.files);
  });

  let cameraModal = null;
  let activeStream = null;
  let currentFacingMode = "environment";

  function stopCameraStream() {
    if (activeStream) {
      try {
        activeStream.getTracks().forEach((track) => track.stop());
      } catch {}
      activeStream = null;
    }
    if (cameraModal) {
      try {
        cameraModal.remove();
      } catch {}
      cameraModal = null;
    }
  }

  window.addEventListener("beforeunload", stopCameraStream);

  async function startStreamWithFacing(facingMode, videoEl) {
    if (activeStream) {
      try {
        activeStream.getTracks().forEach((track) => track.stop());
      } catch {}
      activeStream = null;
    }
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode } },
      audio: false,
    });
    videoEl.srcObject = activeStream;
  }

  async function openLiveCameraModal() {
    stopCameraStream();

    if (!navigator.mediaDevices?.getUserMedia) {
      cameraInput.value = "";
      cameraInput.click();
      return;
    }

    try {
      cameraModal = document.createElement("div");
      cameraModal.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,0.78);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;padding:16px;gap:12px;";

      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.style.cssText =
        "max-width:100%;max-height:70vh;border-radius:10px;background:#000;";

      await startStreamWithFacing(currentFacingMode, video);

      const actions = document.createElement("div");
      actions.style.cssText =
        "display:flex;gap:10px;flex-wrap:wrap;justify-content:center;";

      const snapBtn = document.createElement("button");
      snapBtn.type = "button";
      snapBtn.textContent = "Chụp ảnh";
      snapBtn.style.cssText =
        "padding:10px 18px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;";

      const switchBtn = document.createElement("button");
      switchBtn.type = "button";
      switchBtn.textContent = "Đổi camera";
      switchBtn.style.cssText =
        "padding:10px 18px;border:none;border-radius:8px;background:#475569;color:#fff;font-weight:600;cursor:pointer;";

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.textContent = "Đóng";
      closeBtn.style.cssText =
        "padding:10px 18px;border:none;border-radius:8px;background:#dc2626;color:#fff;font-weight:600;cursor:pointer;";

      snapBtn.addEventListener("click", () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth || 1280;
          canvas.height = video.videoHeight || 720;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(
              (blob) => {
                if (blob) {
                  const file = new File([blob], `camera-${Date.now()}.jpg`, {
                    type: "image/jpeg",
                  });
                  handleFilesSelected([file]);
                }
                stopCameraStream();
              },
              "image/jpeg",
              0.94
            );
          } else {
            stopCameraStream();
          }
        } catch (snapErr) {
          console.warn("Lỗi chụp khung hình camera:", snapErr);
          stopCameraStream();
          cameraInput.value = "";
          cameraInput.click();
        }
      });

      switchBtn.addEventListener("click", async () => {
        currentFacingMode =
          currentFacingMode === "environment" ? "user" : "environment";
        try {
          await startStreamWithFacing(currentFacingMode, video);
        } catch (switchErr) {
          console.warn("Không đổi được camera:", switchErr);
        }
      });

      closeBtn.addEventListener("click", stopCameraStream);

      actions.appendChild(snapBtn);
      actions.appendChild(switchBtn);
      actions.appendChild(closeBtn);
      cameraModal.appendChild(video);
      cameraModal.appendChild(actions);
      document.body.appendChild(cameraModal);
    } catch (err) {
      console.warn("Không mở được webcam trực tiếp, dùng input chụp ảnh:", err);
      stopCameraStream();
      cameraInput.value = "";
      cameraInput.click();
    }
  }

  if (cameraBtn) {
    cameraBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLiveCameraModal();
    });
  }

  function learnFromUserCorrection(beforeText, afterText) {
    if (!beforeText || !afterText || beforeText === afterText) return;
    const beforeTokens = beforeText.trim().split(/\s+/);
    const afterTokens = afterText.trim().split(/\s+/);
    if (beforeTokens.length !== afterTokens.length) return;

    let learned = 0;
    for (let i = 0; i < beforeTokens.length; i++) {
      const wrongLower = beforeTokens[i]
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
        .normalize("NFC")
        .toLowerCase();
      const rightClean = afterTokens[i]
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
        .normalize("NFC");

      if (
        wrongLower.length >= 2 &&
        rightClean.length >= 2 &&
        wrongLower !== rightClean.toLowerCase() &&
        Math.abs(wrongLower.length - rightClean.length) <= 2 &&
        !/^\d+$/.test(wrongLower)
      ) {
        COMMON_OCR_FIXES.set(wrongLower, rightClean);
        learned++;
      }
    }
    if (learned > 0) saveCommonOcrFixes(COMMON_OCR_FIXES);
  }

  if (resultText) {
    resultText.addEventListener("blur", () => {
      learnFromUserCorrection(lastOcrOutputSnapshot, resultText.value);
      lastOcrOutputSnapshot = resultText.value;
    });
  }

  if (copyBtn && resultText) {
    copyBtn.addEventListener("click", async () => {
      learnFromUserCorrection(lastOcrOutputSnapshot, resultText.value);
      lastOcrOutputSnapshot = resultText.value;
      try {
        await navigator.clipboard.writeText(resultText.value);
        setStatus("Đã sao chép kết quả vào bộ nhớ tạm.");
      } catch {
        setStatus(
          "Không thể tự động sao chép, hãy bôi đen và nhấn Ctrl+C.",
          true
        );
      }
    });
  }

  if (downloadBtn && resultText) {
    downloadBtn.addEventListener("click", () => {
      learnFromUserCorrection(lastOcrOutputSnapshot, resultText.value);
      lastOcrOutputSnapshot = resultText.value;
      const blob = new Blob([resultText.value], {
        type: "text/plain;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ket-qua-ocr.txt";
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      selectedFiles = [];
      lastOcrOutputSnapshot = "";
      if (imageInput) imageInput.value = "";
      if (resultText) resultText.value = "";
      if (recognizeBtn) recognizeBtn.disabled = true;
      if (progressWrapper) progressWrapper.classList.add("hidden");
      if (progressBar) progressBar.style.width = "0%";
      if (activeCategoryBadge) activeCategoryBadge.classList.add("hidden");
      setStatus("Đã xóa làm lại.");
    });
  }

  if (recognizeBtn) {
    recognizeBtn.addEventListener("click", async () => {
      if (!selectedFiles.length) {
        setStatus("Vui lòng chọn ít nhất 1 ảnh trước.", true);
        return;
      }

      if (typeof Tesseract === "undefined" || !Tesseract.createWorker) {
        setStatus(
          "Thư viện Tesseract.js chưa tải xong. Hãy kiểm tra kết nối mạng và tải lại trang.",
          true
        );
        return;
      }

      const customLangInput = document.getElementById("customLangInput");
      const lang = (customLangInput?.value || "vie").trim() || "vie";
      const mode = getDocMode();

      let worker = null;

      try {
        recognizeBtn.disabled = true;
        if (progressWrapper) progressWrapper.classList.remove("hidden");
        if (progressBar) progressBar.style.width = "5%";
        if (progressText) progressText.textContent = "Đang khởi tạo... 5%";

        worker = await Tesseract.createWorker(lang, 1, {
          logger: (m) => {
            if (
              m.status === "recognizing text" &&
              typeof m.progress === "number"
            ) {
              const pct = Math.round(