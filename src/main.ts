import "./styles.css";
import { appConfig } from "./config";
import { ScanController } from "./scan-controller";
import type {
  AudioResolution,
  OCRItem,
  OCRResponse,
  OCRResult,
  RuntimeStatus,
  SeatAudioResult,
} from "./types";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app container");
}

const isChrome = /Chrome/.test(navigator.userAgent) && !/Edg|OPR/.test(navigator.userAgent);
const hasCameraApi = Boolean(navigator.mediaDevices?.getUserMedia);
const scanController = new ScanController("Ready");

let latestOCRResult: OCRResult | null = null;
let latestOCRItems: OCRItem[] = [];
let latestRuntimeStatus: RuntimeStatus | null = null;
let preferredFacingMode: "user" | "environment" = "environment";
let selectedCameraId: string | null = null;
let cameraStream: MediaStream | null = null;
let isOCRInFlight = false;
let activeSeatAudio: HTMLAudioElement | null = null;
let nameSeatDirectoryPromise: Promise<Map<string, string>> | null = null;
let runtimePollTimer: number | null = null;

const plannedAudioOutput: AudioResolution = {
  playbackRate: appConfig.audioPlaybackRate,
  segments: [],
};

app.innerHTML = `
  <main class="shell">
    <header>
      <h1>OCR Ticket Reader</h1>
      <p>Webcam frame is sent to the local PaddleOCR backend, then name/seat are parsed in the browser.</p>
    </header>
    <section class="panel">
      <p><strong>Browser check:</strong> ${isChrome ? "Chrome detected" : "Please use desktop Chrome for camera scanning."}</p>
      <p><strong>Camera API:</strong> ${hasCameraApi ? "Available" : "Not available"}</p>
      <p><strong>OCR backend:</strong> <code>${appConfig.ocrBackendUrl}</code></p>
      <p><strong>App mode:</strong> <span id="app-mode">Checking runtime...</span></p>
      <p><strong>Backend runtime:</strong> <span id="backend-runtime">Checking runtime...</span></p>
      <p id="runtime-message">Connecting to the local OCR service...</p>
      <p><strong>Name confidence threshold:</strong> ${appConfig.confidenceThresholdName}</p>
      <p><strong>Seat confidence threshold:</strong> ${appConfig.confidenceThresholdSeat}</p>
      <p><strong>Scan timeout (ms):</strong> ${appConfig.scanTimeoutMs}</p>
      <p><strong>Retry interval (ms):</strong> ${appConfig.retryIntervalMs}</p>
      <p><strong>Audio playback rate:</strong> ${appConfig.audioPlaybackRate}</p>
      <p id="app-state"><strong>App state:</strong> ${scanController.getState()}</p>
      <p id="ocr-summary"><strong>Latest OCR result:</strong> None</p>
      <p><strong>Queued audio segments:</strong> ${plannedAudioOutput.segments.length}</p>
      <p id="camera-message">Camera preview not started.</p>
      <p id="sample-status"><strong>OCR request:</strong> idle</p>

      <div class="camera-controls">
        <label for="camera-select"><strong>Camera:</strong></label>
        <select id="camera-select" disabled>
          <option value="">Default rear camera</option>
        </select>
        <button id="switch-facing-btn" type="button" disabled>Switch to Front Camera</button>
      </div>

      <div class="preview-frame">
        <video id="camera-preview" autoplay muted playsinline></video>
      </div>

      <div class="result-panel">
        <h2>Parsed Result</h2>
        <p id="result-name"><strong>Name:</strong> -</p>
        <p id="result-seat"><strong>Seat:</strong> -</p>
        <p id="result-confidence"><strong>Confidence:</strong> -</p>
        <p id="audio-seat"><strong>CSV seat:</strong> -</p>
        <p id="audio-status"><strong>Seat audio:</strong> idle</p>
      </div>

      <div class="result-panel">
        <h2>Raw OCR</h2>
        <p id="ocr-count"><strong>Lines:</strong> 0</p>
        <pre id="ocr-raw" class="ocr-raw">[]</pre>
      </div>

      <div class="result-panel">
        <h2>Diagnostics</h2>
        <p id="backend-path"><strong>Backend path:</strong> -</p>
        <p id="backend-request"><strong>Request ID:</strong> -</p>
        <p id="backend-attempt"><strong>Attempt:</strong> -</p>
        <p id="backend-pass"><strong>Selected pass:</strong> -</p>
        <p id="parser-status"><strong>Parser status:</strong> -</p>
        <pre id="ocr-diagnostics" class="ocr-raw ocr-diagnostics">{}</pre>
      </div>

      <div class="actions">
        <button id="start-camera-btn" type="button" disabled>Enable Camera</button>
        <button id="capture-ocr-btn" type="button" disabled>Capture &amp; Send to OCR</button>
        <button id="stop-camera-btn" type="button" disabled>Stop Camera</button>
        <button id="quit-app-btn" type="button" hidden disabled>Quit App</button>
      </div>
    </section>
  </main>
`;

const appStateElement = document.querySelector<HTMLParagraphElement>("#app-state");
const appModeElement = document.querySelector<HTMLSpanElement>("#app-mode");
const runtimeStateElement = document.querySelector<HTMLSpanElement>("#backend-runtime");
const runtimeMessageElement = document.querySelector<HTMLParagraphElement>("#runtime-message");
const cameraMessageElement = document.querySelector<HTMLParagraphElement>("#camera-message");
const sampleStatusElement = document.querySelector<HTMLParagraphElement>("#sample-status");
const ocrSummaryElement = document.querySelector<HTMLParagraphElement>("#ocr-summary");
const previewElement = document.querySelector<HTMLVideoElement>("#camera-preview");
const resultNameElement = document.querySelector<HTMLParagraphElement>("#result-name");
const resultSeatElement = document.querySelector<HTMLParagraphElement>("#result-seat");
const resultConfidenceElement = document.querySelector<HTMLParagraphElement>("#result-confidence");
const audioSeatElement = document.querySelector<HTMLParagraphElement>("#audio-seat");
const audioStatusElement = document.querySelector<HTMLParagraphElement>("#audio-status");
const ocrCountElement = document.querySelector<HTMLParagraphElement>("#ocr-count");
const ocrRawElement = document.querySelector<HTMLPreElement>("#ocr-raw");
const backendPathElement = document.querySelector<HTMLParagraphElement>("#backend-path");
const backendRequestElement = document.querySelector<HTMLParagraphElement>("#backend-request");
const backendAttemptElement = document.querySelector<HTMLParagraphElement>("#backend-attempt");
const backendPassElement = document.querySelector<HTMLParagraphElement>("#backend-pass");
const parserStatusElement = document.querySelector<HTMLParagraphElement>("#parser-status");
const ocrDiagnosticsElement = document.querySelector<HTMLPreElement>("#ocr-diagnostics");
const cameraSelectElement = document.querySelector<HTMLSelectElement>("#camera-select");
const switchFacingButton = document.querySelector<HTMLButtonElement>("#switch-facing-btn");
const startCameraButton = document.querySelector<HTMLButtonElement>("#start-camera-btn");
const captureOCRButton = document.querySelector<HTMLButtonElement>("#capture-ocr-btn");
const stopCameraButton = document.querySelector<HTMLButtonElement>("#stop-camera-btn");
const quitAppButton = document.querySelector<HTMLButtonElement>("#quit-app-btn");

if (
  !appStateElement ||
  !appModeElement ||
  !runtimeStateElement ||
  !runtimeMessageElement ||
  !cameraMessageElement ||
  !sampleStatusElement ||
  !ocrSummaryElement ||
  !previewElement ||
  !resultNameElement ||
  !resultSeatElement ||
  !resultConfidenceElement ||
  !audioSeatElement ||
  !audioStatusElement ||
  !ocrCountElement ||
  !ocrRawElement ||
  !backendPathElement ||
  !backendRequestElement ||
  !backendAttemptElement ||
  !backendPassElement ||
  !parserStatusElement ||
  !ocrDiagnosticsElement ||
  !cameraSelectElement ||
  !switchFacingButton ||
  !startCameraButton ||
  !captureOCRButton ||
  !stopCameraButton ||
  !quitAppButton
) {
  throw new Error("Missing app elements");
}

const sampleCanvas = document.createElement("canvas");
const sampleContext = sampleCanvas.getContext("2d");

const seatRegex = /([0-9]{2}[A-Z]{2}[0-9]{2})/;
const excludedNameWords = new Set(["sample", "graduate"]);

type Candidate = { text: string; confidence: number; index: number };

type ParserDebug = {
  failureReason: string | null;
  seatCandidates: Candidate[];
  nameCandidates: Candidate[];
  selectedSeat: Candidate | null;
  selectedName: Candidate | null;
};

const setAppState = (stateLabel: string): void => {
  appStateElement.innerHTML = `<strong>App state:</strong> ${stateLabel}`;
};

const setCameraMessage = (message: string): void => {
  cameraMessageElement.textContent = message;
};

const setSampleStatus = (message: string): void => {
  sampleStatusElement.innerHTML = `<strong>OCR request:</strong> ${message}`;
};

const updateSeatAudioDisplay = (result: SeatAudioResult): void => {
  audioSeatElement.innerHTML = `<strong>CSV seat:</strong> ${result.resolvedSeat ?? "-"}`;
  audioStatusElement.innerHTML = `<strong>Seat audio:</strong> ${result.message}`;
};

const stopSeatAudioPlayback = (): void => {
  if (!activeSeatAudio) {
    return;
  }

  activeSeatAudio.pause();
  activeSeatAudio.currentTime = 0;
  activeSeatAudio = null;
};

const parseNameSeatDirectory = (csvText: string): Map<string, string> => {
  const rows = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rows.length === 0) {
    throw new Error("names.csv is empty");
  }

  const header = rows[0].replace(/^\ufeff/, "");
  if (header !== "Seat No,Chinese Name") {
    throw new Error(`Unexpected names.csv header: ${header}`);
  }

  const directory = new Map<string, string>();

  for (const row of rows.slice(1)) {
    const separatorIndex = row.indexOf(",");
    if (separatorIndex <= 0 || separatorIndex === row.length - 1) {
      continue;
    }

    const seat = row.slice(0, separatorIndex).trim();
    const name = row.slice(separatorIndex + 1).trim();
    if (seat && name) {
      directory.set(name, seat);
    }
  }

  return directory;
};

const loadNameSeatDirectory = async (): Promise<Map<string, string>> => {
  const response = await fetch("/names.csv", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`names.csv returned ${response.status}`);
  }

  return parseNameSeatDirectory(await response.text());
};

const ensureNameSeatDirectory = async (): Promise<Map<string, string>> => {
  if (!nameSeatDirectoryPromise) {
    nameSeatDirectoryPromise = loadNameSeatDirectory().catch((error: unknown) => {
      nameSeatDirectoryPromise = null;
      throw error;
    });
  }

  return nameSeatDirectoryPromise;
};

const buildSeatAudioUrl = (seatNumber: string): string => `/audio/${encodeURIComponent(seatNumber)}.wav`;

const resolveAndPlaySeatAudio = async (lookupName: string | null): Promise<SeatAudioResult> => {
  if (!lookupName) {
    stopSeatAudioPlayback();
    return {
      lookupName: null,
      resolvedSeat: null,
      sourceUrl: null,
      status: "skipped",
      message: "skipped (no parsed name)",
    };
  }

  let directory: Map<string, string>;
  try {
    directory = await ensureNameSeatDirectory();
  } catch (error) {
    stopSeatAudioPlayback();
    const message = error instanceof Error ? error.message : "Unable to load names.csv";
    return {
      lookupName,
      resolvedSeat: null,
      sourceUrl: null,
      status: "error",
      message: `error (${message})`,
    };
  }

  const resolvedSeat = directory.get(lookupName) ?? null;
  if (!resolvedSeat) {
    stopSeatAudioPlayback();
    return {
      lookupName,
      resolvedSeat: null,
      sourceUrl: null,
      status: "skipped",
      message: `skipped (no CSV match for ${lookupName})`,
    };
  }

  const sourceUrl = buildSeatAudioUrl(resolvedSeat);
  const audio = new Audio(sourceUrl);
  audio.playbackRate = appConfig.audioPlaybackRate;
  audio.preload = "auto";

  stopSeatAudioPlayback();
  activeSeatAudio = audio;

  try {
    await audio.play();
    audio.addEventListener(
      "ended",
      () => {
        if (activeSeatAudio === audio) {
          activeSeatAudio = null;
        }
      },
      { once: true },
    );

    return {
      lookupName,
      resolvedSeat,
      sourceUrl,
      status: "playing",
      message: `playing ${resolvedSeat}.wav`,
    };
  } catch (error) {
    if (activeSeatAudio === audio) {
      activeSeatAudio = null;
    }

    const message = error instanceof Error ? error.message : "Audio playback failed";
    return {
      lookupName,
      resolvedSeat,
      sourceUrl,
      status: "error",
      message: `error (${message})`,
    };
  }
};

const updateDiagnosticsDisplay = (response: OCRResponse | null, parserDebug: ParserDebug | null): void => {
  const path = response?.profiling?.path ?? "-";
  const requestId = response?.debug?.request_id ?? "-";
  const attemptNumber = response?.debug?.attempt_number;
  const attemptDir = response?.debug?.attempt_dir;
  const selectedPass = response?.debug?.label_detection?.selected_pass ?? "-";
  const parserStatus = parserDebug ? parserDebug.failureReason ?? "parsed" : "-";

  backendPathElement.innerHTML = `<strong>Backend path:</strong> ${path}`;
  backendRequestElement.innerHTML = `<strong>Request ID:</strong> ${requestId}`;
  backendAttemptElement.innerHTML = `<strong>Attempt:</strong> ${
    attemptNumber && attemptDir ? `${attemptNumber} (${attemptDir})` : "-"
  }`;
  backendPassElement.innerHTML = `<strong>Selected pass:</strong> ${selectedPass}`;
  parserStatusElement.innerHTML = `<strong>Parser status:</strong> ${parserStatus}`;
  ocrDiagnosticsElement.textContent = JSON.stringify(
    {
      profiling: response?.profiling ?? null,
      debug: response?.debug ?? null,
      parser: parserDebug ?? null,
      serviceState: response?.service_state ?? latestRuntimeStatus ?? null,
    },
    null,
    2,
  );
};

const updateOCRDisplay = (items: OCRItem[], result: OCRResult | null, parserDebug: ParserDebug | null): void => {
  latestOCRItems = items;
  latestOCRResult = result;

  ocrCountElement.innerHTML = `<strong>Lines:</strong> ${items.length}`;
  ocrRawElement.textContent = JSON.stringify(items.slice(0, 20), null, 2);

  if (!result) {
    const partialName = parserDebug?.selectedName?.text ?? null;
    const partialSeat = parserDebug?.selectedSeat?.text ?? null;

    if (!partialName && !partialSeat) {
      ocrSummaryElement.innerHTML = "<strong>Latest OCR result:</strong> No valid name/seat parsed";
      resultNameElement.innerHTML = "<strong>Name:</strong> -";
      resultSeatElement.innerHTML = "<strong>Seat:</strong> -";
      resultConfidenceElement.innerHTML = "<strong>Confidence:</strong> -";
      return;
    }

    const partialNameConfidence = parserDebug?.selectedName?.confidence;
    const partialSeatConfidence = parserDebug?.selectedSeat?.confidence;
    const partialCombinedConfidence =
      partialNameConfidence !== undefined && partialSeatConfidence !== undefined
        ? Math.min(partialNameConfidence, partialSeatConfidence)
        : undefined;

    ocrSummaryElement.innerHTML = "<strong>Latest OCR result:</strong> Partial parse";
    resultNameElement.innerHTML = `<strong>Name:</strong> ${partialName ?? "-"}`;
    resultSeatElement.innerHTML = `<strong>Seat:</strong> ${partialSeat ?? "-"}`;
    resultConfidenceElement.innerHTML = `<strong>Confidence:</strong> name ${
      partialNameConfidence !== undefined ? partialNameConfidence.toFixed(2) : "-"
    }, seat ${
      partialSeatConfidence !== undefined ? partialSeatConfidence.toFixed(2) : "-"
    }, combined ${
      partialCombinedConfidence !== undefined ? partialCombinedConfidence.toFixed(2) : "-"
    }`;
    return;
  }

  ocrSummaryElement.innerHTML = "<strong>Latest OCR result:</strong> Parsed";
  resultNameElement.innerHTML = `<strong>Name:</strong> ${result.holderName}`;
  resultSeatElement.innerHTML = `<strong>Seat:</strong> ${result.seatNumber}`;
  resultConfidenceElement.innerHTML = `<strong>Confidence:</strong> name ${result.confidence.name.toFixed(2)}, seat ${result.confidence.seat.toFixed(2)}, combined ${result.confidence.combined.toFixed(2)}`;
};

const inferFacingModeFromLabel = (label: string): "user" | "environment" | null => {
  const lowerLabel = label.toLowerCase();
  if (/(back|rear|environment|world)/.test(lowerLabel)) {
    return "environment";
  }

  if (/(front|user|facetime|selfie)/.test(lowerLabel)) {
    return "user";
  }

  return null;
};

const setSwitchFacingLabel = (): void => {
  switchFacingButton.textContent =
    preferredFacingMode === "environment" ? "Switch to Front Camera" : "Switch to Rear Camera";
};

const isRuntimeReady = (): boolean => Boolean(latestRuntimeStatus?.is_ready);

const updateActionAvailability = (): void => {
  const canStartCamera = hasCameraApi && isChrome && isRuntimeReady() && !cameraStream;
  startCameraButton.disabled = !canStartCamera;
  captureOCRButton.disabled = !cameraStream || isOCRInFlight || !isRuntimeReady();
  stopCameraButton.disabled = !cameraStream;
  cameraSelectElement.disabled = !cameraStream;
  switchFacingButton.disabled = !cameraStream;
  quitAppButton.hidden = !(latestRuntimeStatus?.packaged ?? false);
  quitAppButton.disabled = !(latestRuntimeStatus?.packaged ?? false);
  setSwitchFacingLabel();
};

const updateRuntimeDisplay = (status: RuntimeStatus | null): void => {
  if (!status) {
    appModeElement.textContent = "Waiting for backend";
    runtimeStateElement.textContent = "Unavailable";
    runtimeMessageElement.textContent = "Connecting to the local OCR service...";
    updateActionAvailability();
    return;
  }

  appModeElement.textContent = status.packaged ? "Packaged local app" : "Developer mode";
  runtimeStateElement.textContent = `${status.state}${status.is_ready ? " (ready)" : ""}`;

  let runtimeMessage = status.message;
  if (status.error) {
    runtimeMessage = `${status.message} Log file: ${status.log_file}`;
  } else if (!status.is_ready && status.cached_models_present) {
    runtimeMessage = `${status.message} Using cached models from ${status.model_cache_dir}.`;
  } else if (!status.is_ready) {
    runtimeMessage = `${status.message} Model cache directory: ${status.model_cache_dir}.`;
  }

  runtimeMessageElement.textContent = runtimeMessage;
  updateActionAvailability();
};

const syncRuntimeStatus = (status: RuntimeStatus): void => {
  latestRuntimeStatus = status;
  updateRuntimeDisplay(status);

  if (status.is_ready) {
    void ensureNameSeatDirectory().catch(() => {
      updateSeatAudioDisplay({
        lookupName: null,
        resolvedSeat: null,
        sourceUrl: null,
        status: "error",
        message: "error (unable to preload names.csv)",
      });
    });
  }
};

const scheduleRuntimePoll = (delayMs: number): void => {
  if (runtimePollTimer !== null) {
    window.clearTimeout(runtimePollTimer);
  }

  runtimePollTimer = window.setTimeout(() => {
    void refreshRuntimeStatus();
  }, delayMs);
};

const refreshRuntimeStatus = async (): Promise<void> => {
  try {
    const response = await fetch("/runtime/status", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`/runtime/status returned ${response.status}`);
    }

    syncRuntimeStatus((await response.json()) as RuntimeStatus);
  } catch (error) {
    latestRuntimeStatus = null;
    updateRuntimeDisplay(null);
    runtimeMessageElement.textContent =
      error instanceof Error ? `Runtime status check failed: ${error.message}` : "Runtime status check failed.";
  } finally {
    scheduleRuntimePoll(isRuntimeReady() ? 15000 : 1500);
  }
};

const updateCameraControlsState = async (): Promise<void> => {
  if (!navigator.mediaDevices?.enumerateDevices) {
    cameraSelectElement.innerHTML = `<option value="">Default camera</option>`;
    updateActionAvailability();
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter((device) => device.kind === "videoinput");

  if (videoDevices.length === 0) {
    cameraSelectElement.innerHTML = `<option value="">No camera devices detected</option>`;
    updateActionAvailability();
    return;
  }

  cameraSelectElement.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = preferredFacingMode === "environment" ? "Default rear camera" : "Default front camera";
  cameraSelectElement.append(defaultOption);

  for (const [index, device] of videoDevices.entries()) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Camera ${index + 1}`;
    cameraSelectElement.append(option);
  }

  cameraSelectElement.value = selectedCameraId ?? "";
  updateActionAvailability();
};

const getVideoConstraints = (): MediaTrackConstraints => {
  if (selectedCameraId) {
    return {
      deviceId: { exact: selectedCameraId },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    };
  }

  return {
    facingMode: { ideal: preferredFacingMode },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };
};

const captureFrameBlob = async (): Promise<Blob | null> => {
  if (!sampleContext) {
    return null;
  }

  const width = previewElement.videoWidth;
  const height = previewElement.videoHeight;

  if (width <= 0 || height <= 0) {
    return null;
  }

  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  sampleCanvas.width = targetWidth;
  sampleCanvas.height = targetHeight;
  sampleContext.drawImage(previewElement, 0, 0, targetWidth, targetHeight);

  return new Promise((resolve) => {
    sampleCanvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85);
  });
};

const sanitizeSeatText = (text: string): string => text.toUpperCase().replace(/[^A-Z0-9]/g, "");

const parseResultFromOCRItems = (items: OCRItem[]): { result: OCRResult | null; debug: ParserDebug } => {
  if (items.length === 0) {
    return {
      result: null,
      debug: {
        failureReason: "no_ocr_items",
        seatCandidates: [],
        nameCandidates: [],
        selectedSeat: null,
        selectedName: null,
      },
    };
  }

  const seatCandidates: Candidate[] = [];
  const nameCandidates: Candidate[] = [];

  for (const [index, item] of items.entries()) {
    const normalized = sanitizeSeatText(item.text);
    const seatMatch = seatRegex.exec(normalized);
    if (seatMatch?.[1]) {
      seatCandidates.push({ text: seatMatch[1], confidence: item.confidence, index });
    }

    const trimmed = item.text.trim();
    const hasNameLikeChars = /[A-Za-z\u4e00-\u9fff]/.test(trimmed);
    const looksLikeLabel = /(seat|座位|姓名|name)/i.test(trimmed);
    const normalizedName = trimmed.toLowerCase();
    const isExcludedNameWord = excludedNameWords.has(normalizedName);
    if (trimmed.length >= 2 && hasNameLikeChars && !looksLikeLabel && !isExcludedNameWord) {
      nameCandidates.push({ text: trimmed, confidence: item.confidence, index });
    }
  }

  seatCandidates.sort((a, b) => b.confidence - a.confidence);
  nameCandidates.sort((a, b) => b.confidence - a.confidence);
  const selectedSeat = seatCandidates[0] ?? null;

  if (seatCandidates.length === 0) {
    return {
      result: null,
      debug: {
        failureReason: "no_seat_candidate",
        seatCandidates,
        nameCandidates,
        selectedSeat,
        selectedName: nameCandidates[0] ?? null,
      },
    };
  }

  const seat = selectedSeat;
  if (!seat) {
    return {
      result: null,
      debug: {
        failureReason: "no_seat_candidate",
        seatCandidates,
        nameCandidates,
        selectedSeat: null,
        selectedName: nameCandidates[0] ?? null,
      },
    };
  }

  const filteredNameCandidates = nameCandidates.filter((candidate) => candidate.index !== seat.index);
  filteredNameCandidates.sort((a, b) => b.confidence - a.confidence);
  const selectedName = filteredNameCandidates[0] ?? null;

  if (filteredNameCandidates.length === 0) {
    return {
      result: null,
      debug: {
        failureReason: nameCandidates.length > 0 ? "name_candidates_only_on_seat_line" : "no_name_candidate",
        seatCandidates,
        nameCandidates,
        selectedSeat: seat,
        selectedName,
      },
    };
  }

  const name = selectedName;
  if (!name) {
    return {
      result: null,
      debug: {
        failureReason: "no_name_candidate",
        seatCandidates,
        nameCandidates,
        selectedSeat: seat,
        selectedName: null,
      },
    };
  }

  const combined = Math.min(name.confidence, seat.confidence);
  return {
    result: {
      holderName: name.text,
      seatNumber: seat.text,
      confidence: {
        name: name.confidence,
        seat: seat.confidence,
        combined,
      },
    },
    debug: {
      failureReason: null,
      seatCandidates,
      nameCandidates,
      selectedSeat: seat,
      selectedName: name,
    },
  };
};

const fetchOCRData = async (blob: Blob): Promise<OCRResponse> => {
  const formData = new FormData();
  formData.append("file", blob, "frame.jpg");

  const timeoutMs = Math.max(500, appConfig.scanTimeoutMs);
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(appConfig.ocrBackendUrl, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    let data: OCRResponse | null = null;
    try {
      data = (await response.json()) as OCRResponse;
    } catch {
      data = null;
    }

    if (data?.service_state) {
      syncRuntimeStatus(data.service_state);
    }

    if (!response.ok) {
      const message =
        typeof data?.error === "string" && data.error.trim().length > 0
          ? data.error
          : `OCR backend returned ${response.status}`;
      throw new Error(message);
    }

    if (data === null) {
      throw new Error("OCR backend returned an unreadable response.");
    }

    if (typeof data.error === "string" && data.error.trim().length > 0) {
      throw new Error(`OCR backend error: ${data.error}`);
    }

    return data;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const captureAndSendOCR = async (): Promise<void> => {
  if (!cameraStream || isOCRInFlight) {
    return;
  }

  if (!isRuntimeReady()) {
    setCameraMessage(latestRuntimeStatus?.message ?? "OCR runtime is not ready yet.");
    return;
  }

  const blob = await captureFrameBlob();
  if (!blob) {
    setCameraMessage("No video frame available yet. Wait for the preview to load and try again.");
    return;
  }

  scanController.setState("Scanning");
  isOCRInFlight = true;
  updateActionAvailability();
  setSampleStatus("sending");

  try {
    const response = await fetchOCRData(blob);
    const items = Array.isArray(response.results) ? response.results : [];
    const { result: parsed, debug: parserDebug } = parseResultFromOCRItems(items);
    const lookupName = parserDebug.selectedName?.text.trim() ?? null;
    const seatAudioResult = await resolveAndPlaySeatAudio(lookupName);

    if (parsed) {
      const passName = parsed.confidence.name >= appConfig.confidenceThresholdName;
      const passSeat = parsed.confidence.seat >= appConfig.confidenceThresholdSeat;
      if (passName && passSeat) {
        scanController.setState("Recognized");
      } else {
        scanController.setState("RetryNeeded");
      }
    } else {
      scanController.setState("Scanning");
    }

    updateOCRDisplay(items, parsed, parserDebug);
    updateSeatAudioDisplay(seatAudioResult);
    updateDiagnosticsDisplay(response, parserDebug);
    setSampleStatus(`completed (${items.length} OCR lines)`);
    setCameraMessage("Capture sent to OCR.");
  } catch (error) {
    scanController.setState("RetryNeeded");
    updateDiagnosticsDisplay(null, null);
    updateSeatAudioDisplay({
      lookupName: null,
      resolvedSeat: null,
      sourceUrl: null,
      status: "error",
      message: "error (OCR request failed before audio lookup)",
    });
    if (error instanceof DOMException && error.name === "AbortError") {
      setCameraMessage(`OCR request timed out after ${Math.max(500, appConfig.scanTimeoutMs)}ms.`);
    } else {
      setCameraMessage(error instanceof Error ? `OCR request failed: ${error.message}` : "OCR request failed.");
    }
    setSampleStatus("failed");
  } finally {
    isOCRInFlight = false;
    updateActionAvailability();
  }
};

const stopPreview = (): void => {
  isOCRInFlight = false;
  setSampleStatus("idle");

  if (cameraStream) {
    for (const track of cameraStream.getTracks()) {
      track.stop();
    }
  }

  cameraStream = null;
  previewElement.srcObject = null;
  scanController.setState("Ready");
  stopSeatAudioPlayback();
  updateSeatAudioDisplay({
    lookupName: null,
    resolvedSeat: null,
    sourceUrl: null,
    status: "idle",
    message: "idle",
  });
  setCameraMessage("Camera preview stopped.");
  updateActionAvailability();
};

const startPreview = async (): Promise<void> => {
  if (!hasCameraApi) {
    scanController.setState("RetryNeeded");
    setCameraMessage("Camera API is unavailable in this browser.");
    return;
  }

  if (!isChrome) {
    scanController.setState("RetryNeeded");
    setCameraMessage("Camera scanning is currently supported on desktop Chrome only.");
    return;
  }

  if (!isRuntimeReady()) {
    scanController.setState("RetryNeeded");
    setCameraMessage(latestRuntimeStatus?.message ?? "OCR runtime is still starting.");
    return;
  }

  try {
    startCameraButton.disabled = true;
    setCameraMessage("Requesting camera permission...");

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: getVideoConstraints(),
      audio: false,
    });

    previewElement.srcObject = cameraStream;
    const activeTrack = cameraStream.getVideoTracks()[0];
    const activeSettings = activeTrack?.getSettings();
    if (activeSettings?.deviceId) {
      selectedCameraId = activeSettings.deviceId;
    }

    if (activeTrack?.label) {
      const inferred = inferFacingModeFromLabel(activeTrack.label);
      if (inferred) {
        preferredFacingMode = inferred;
      }
    }

    await updateCameraControlsState();

    scanController.setState("Scanning");
    setSampleStatus("idle");
    setCameraMessage("Camera preview active. Press Capture to send one image to OCR.");
    updateActionAvailability();
  } catch (error) {
    setSampleStatus("idle");
    scanController.setState("RetryNeeded");
    setCameraMessage(error instanceof Error ? `Unable to start camera: ${error.message}` : "Unable to start camera.");
    updateActionAvailability();
  }
};

const requestShutdown = async (): Promise<void> => {
  if (!(latestRuntimeStatus?.packaged ?? false)) {
    return;
  }

  quitAppButton.disabled = true;

  try {
    const response = await fetch("/shutdown", {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`/shutdown returned ${response.status}`);
    }

    runtimeMessageElement.textContent = "Application is shutting down...";
    stopPreview();
  } catch (error) {
    runtimeMessageElement.textContent =
      error instanceof Error ? `Quit request failed: ${error.message}` : "Quit request failed.";
    quitAppButton.disabled = false;
  }
};

scanController.subscribe(setAppState);
updateRuntimeDisplay(null);
updateSeatAudioDisplay({
  lookupName: null,
  resolvedSeat: null,
  sourceUrl: null,
  status: "idle",
  message: "idle",
});
void updateCameraControlsState();
void refreshRuntimeStatus();

startCameraButton.addEventListener("click", () => {
  void startPreview();
});

captureOCRButton.addEventListener("click", () => {
  void captureAndSendOCR();
});

stopCameraButton.addEventListener("click", stopPreview);

quitAppButton.addEventListener("click", () => {
  void requestShutdown();
});

cameraSelectElement.addEventListener("change", () => {
  selectedCameraId = cameraSelectElement.value || null;
  if (cameraStream) {
    stopPreview();
    void startPreview();
  }
});

switchFacingButton.addEventListener("click", () => {
  preferredFacingMode = preferredFacingMode === "environment" ? "user" : "environment";
  selectedCameraId = null;
  void updateCameraControlsState();

  if (cameraStream) {
    stopPreview();
    void startPreview();
  } else {
    setSwitchFacingLabel();
  }
});

navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  void updateCameraControlsState();
});

window.addEventListener("beforeunload", () => {
  if (runtimePollTimer !== null) {
    window.clearTimeout(runtimePollTimer);
  }
  stopPreview();
});
