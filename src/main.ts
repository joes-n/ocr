import "./styles.css";
import { appConfig } from "./config";
import { ScanController } from "./scan-controller";
import type { AudioResolution, OCRItem, OCRResult } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app container");
}

const isChrome = /Chrome/.test(navigator.userAgent) && !/Edg|OPR/.test(navigator.userAgent);
const hasCameraApi = Boolean(navigator.mediaDevices?.getUserMedia);
const scanController = new ScanController("Ready");
const frameSampleIntervalMs = appConfig.retryIntervalMs;

let latestOCRResult: OCRResult | null = null;
let latestOCRItems: OCRItem[] = [];
let preferredFacingMode: "user" | "environment" = "environment";
let selectedCameraId: string | null = null;
let cameraStream: MediaStream | null = null;
let samplingTimerId: number | null = null;
let sampleCount = 0;
let isOCRInFlight = false;

const plannedAudioOutput: AudioResolution = {
  playbackRate: appConfig.audioPlaybackRate,
  segments: []
};

app.innerHTML = `
  <main class="shell">
    <header>
      <h1>OCR Ticket Reader</h1>
      <p>Webcam frame is sent to PaddleOCR backend, then name/seat are parsed in frontend.</p>
    </header>
    <section class="panel">
      <p><strong>Browser check:</strong> ${isChrome ? "Chrome detected" : "Please use desktop Chrome for MVP."}</p>
      <p><strong>Camera API:</strong> ${hasCameraApi ? "Available" : "Not available"}</p>
      <p><strong>OCR backend:</strong> <code>${appConfig.ocrBackendUrl}</code></p>
      <p><strong>Name confidence threshold:</strong> ${appConfig.confidenceThresholdName}</p>
      <p><strong>Seat confidence threshold:</strong> ${appConfig.confidenceThresholdSeat}</p>
      <p><strong>Scan timeout (ms):</strong> ${appConfig.scanTimeoutMs}</p>
      <p><strong>Retry interval (ms):</strong> ${appConfig.retryIntervalMs}</p>
      <p><strong>Frame sample interval (ms):</strong> ${frameSampleIntervalMs}</p>
      <p><strong>Audio playback rate:</strong> ${appConfig.audioPlaybackRate}</p>
      <p id="app-state"><strong>App state:</strong> ${scanController.getState()}</p>
      <p id="ocr-summary"><strong>Latest OCR result:</strong> None</p>
      <p><strong>Queued audio segments:</strong> ${plannedAudioOutput.segments.length}</p>
      <p id="camera-message">Camera preview not started.</p>
      <p id="sample-status"><strong>Sample loop:</strong> idle</p>

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
      </div>

      <div class="result-panel">
        <h2>Raw OCR</h2>
        <p id="ocr-count"><strong>Lines:</strong> 0</p>
        <pre id="ocr-raw" class="ocr-raw">[]</pre>
      </div>

      <div class="actions">
        <button id="start-camera-btn" type="button">Enable Camera</button>
        <button id="stop-camera-btn" type="button" disabled>Stop Camera</button>
      </div>
    </section>
  </main>
`;

const appStateElement = document.querySelector<HTMLParagraphElement>("#app-state");
const cameraMessageElement = document.querySelector<HTMLParagraphElement>("#camera-message");
const sampleStatusElement = document.querySelector<HTMLParagraphElement>("#sample-status");
const ocrSummaryElement = document.querySelector<HTMLParagraphElement>("#ocr-summary");
const previewElement = document.querySelector<HTMLVideoElement>("#camera-preview");
const resultNameElement = document.querySelector<HTMLParagraphElement>("#result-name");
const resultSeatElement = document.querySelector<HTMLParagraphElement>("#result-seat");
const resultConfidenceElement = document.querySelector<HTMLParagraphElement>("#result-confidence");
const ocrCountElement = document.querySelector<HTMLParagraphElement>("#ocr-count");
const ocrRawElement = document.querySelector<HTMLPreElement>("#ocr-raw");
const cameraSelectElement = document.querySelector<HTMLSelectElement>("#camera-select");
const switchFacingButton = document.querySelector<HTMLButtonElement>("#switch-facing-btn");
const startCameraButton = document.querySelector<HTMLButtonElement>("#start-camera-btn");
const stopCameraButton = document.querySelector<HTMLButtonElement>("#stop-camera-btn");

if (
  !appStateElement ||
  !cameraMessageElement ||
  !sampleStatusElement ||
  !ocrSummaryElement ||
  !previewElement ||
  !resultNameElement ||
  !resultSeatElement ||
  !resultConfidenceElement ||
  !ocrCountElement ||
  !ocrRawElement ||
  !cameraSelectElement ||
  !switchFacingButton ||
  !startCameraButton ||
  !stopCameraButton
) {
  throw new Error("Missing app elements");
}

const sampleCanvas = document.createElement("canvas");
const sampleContext = sampleCanvas.getContext("2d");

const seatRegex = /([0-9]{2}[A-Z]{2}[0-9]{2})/;

const setAppState = (stateLabel: string): void => {
  appStateElement.innerHTML = `<strong>App state:</strong> ${stateLabel}`;
};

const setCameraMessage = (message: string): void => {
  cameraMessageElement.textContent = message;
};

const setSampleStatus = (message: string): void => {
  sampleStatusElement.innerHTML = `<strong>Sample loop:</strong> ${message}`;
};

const updateOCRDisplay = (items: OCRItem[], result: OCRResult | null): void => {
  latestOCRItems = items;
  latestOCRResult = result;

  ocrCountElement.innerHTML = `<strong>Lines:</strong> ${items.length}`;
  ocrRawElement.textContent = JSON.stringify(items.slice(0, 20), null, 2);

  if (!result) {
    ocrSummaryElement.innerHTML = "<strong>Latest OCR result:</strong> No valid name/seat parsed";
    resultNameElement.innerHTML = "<strong>Name:</strong> -";
    resultSeatElement.innerHTML = "<strong>Seat:</strong> -";
    resultConfidenceElement.innerHTML = "<strong>Confidence:</strong> -";
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

const updateCameraControlsState = (enabled: boolean): void => {
  cameraSelectElement.disabled = !enabled;
  switchFacingButton.disabled = !enabled;
  setSwitchFacingLabel();
};

const populateCameraOptions = async (): Promise<void> => {
  if (!navigator.mediaDevices?.enumerateDevices) {
    cameraSelectElement.innerHTML = `<option value="">Default camera</option>`;
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter((device) => device.kind === "videoinput");

  if (videoDevices.length === 0) {
    cameraSelectElement.innerHTML = `<option value="">No camera devices detected</option>`;
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
};

const getVideoConstraints = (): MediaTrackConstraints => {
  if (selectedCameraId) {
    return {
      deviceId: { exact: selectedCameraId },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    };
  }

  return {
    facingMode: { ideal: preferredFacingMode },
    width: { ideal: 1280 },
    height: { ideal: 720 }
  };
};

const stopSampling = (): void => {
  if (samplingTimerId !== null) {
    window.clearInterval(samplingTimerId);
    samplingTimerId = null;
  }

  sampleCount = 0;
  isOCRInFlight = false;
  setSampleStatus("idle");
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

const parseResultFromOCRItems = (items: OCRItem[]): OCRResult | null => {
  if (items.length === 0) {
    return null;
  }

  type Candidate = { text: string; confidence: number; index: number };

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
    if (trimmed.length >= 2 && hasNameLikeChars && !looksLikeLabel) {
      nameCandidates.push({ text: trimmed, confidence: item.confidence, index });
    }
  }

  if (seatCandidates.length === 0) {
    return null;
  }

  seatCandidates.sort((a, b) => b.confidence - a.confidence);
  const seat = seatCandidates[0];

  const filteredNameCandidates = nameCandidates.filter((candidate) => candidate.index !== seat.index);
  if (filteredNameCandidates.length === 0) {
    return null;
  }

  filteredNameCandidates.sort((a, b) => b.confidence - a.confidence);
  const name = filteredNameCandidates[0];

  const combined = Math.min(name.confidence, seat.confidence);
  return {
    holderName: name.text,
    seatNumber: seat.text,
    confidence: {
      name: name.confidence,
      seat: seat.confidence,
      combined
    }
  };
};

const fetchOCRItems = async (blob: Blob): Promise<OCRItem[]> => {
  const formData = new FormData();
  formData.append("file", blob, "frame.jpg");

  const timeoutMs = Math.max(500, appConfig.scanTimeoutMs);
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(appConfig.ocrBackendUrl, {
      method: "POST",
      body: formData,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`OCR backend returned ${response.status}`);
    }

    const data = (await response.json()) as { results?: OCRItem[] };
    return Array.isArray(data.results) ? data.results : [];
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const sampleFrame = async (): Promise<void> => {
  if (!cameraStream || isOCRInFlight) {
    return;
  }

  const blob = await captureFrameBlob();
  if (!blob) {
    return;
  }

  isOCRInFlight = true;
  sampleCount += 1;

  try {
    const items = await fetchOCRItems(blob);
    const parsed = parseResultFromOCRItems(items);

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

    updateOCRDisplay(items, parsed);
    setSampleStatus(`running (${sampleCount} samples, ${items.length} OCR lines)`);
    setCameraMessage("Camera preview active. Sending sampled frames to backend OCR.");
  } catch (error) {
    scanController.setState("RetryNeeded");
    setCameraMessage(error instanceof Error ? `OCR request failed: ${error.message}` : "OCR request failed.");
    setSampleStatus(`running (${sampleCount} samples, backend error)`);
  } finally {
    isOCRInFlight = false;
  }
};

const startSampling = (): void => {
  stopSampling();
  setSampleStatus("starting");
  samplingTimerId = window.setInterval(() => {
    void sampleFrame();
  }, frameSampleIntervalMs);
};

const stopPreview = (): void => {
  stopSampling();

  if (!cameraStream) {
    return;
  }

  for (const track of cameraStream.getTracks()) {
    track.stop();
  }

  cameraStream = null;
  previewElement.srcObject = null;
  stopCameraButton.disabled = true;
  startCameraButton.disabled = !hasCameraApi || !isChrome;
  updateCameraControlsState(hasCameraApi && isChrome);
  scanController.setState("Ready");
  setCameraMessage("Camera preview stopped.");
};

const startPreview = async (): Promise<void> => {
  if (!hasCameraApi) {
    scanController.setState("RetryNeeded");
    setCameraMessage("Camera API is unavailable in this browser.");
    return;
  }

  if (!isChrome) {
    scanController.setState("RetryNeeded");
    setCameraMessage("MVP camera flow is currently supported on desktop Chrome only.");
    return;
  }

  try {
    startCameraButton.disabled = true;
    setCameraMessage("Requesting camera permission...");

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: getVideoConstraints(),
      audio: false
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

    await populateCameraOptions();

    scanController.setState("Scanning");
    setCameraMessage("Camera preview active. Waiting for OCR samples...");
    startSampling();
    stopCameraButton.disabled = false;
    updateCameraControlsState(true);
  } catch (error) {
    stopSampling();
    scanController.setState("RetryNeeded");
    startCameraButton.disabled = false;
    updateCameraControlsState(hasCameraApi && isChrome);
    setCameraMessage(error instanceof Error ? `Unable to start camera: ${error.message}` : "Unable to start camera.");
  }
};

scanController.subscribe(setAppState);
startCameraButton.disabled = !hasCameraApi || !isChrome;
updateCameraControlsState(hasCameraApi && isChrome);
void populateCameraOptions();

startCameraButton.addEventListener("click", () => {
  void startPreview();
});

stopCameraButton.addEventListener("click", stopPreview);

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
  void populateCameraOptions();

  if (cameraStream) {
    stopPreview();
    void startPreview();
  } else {
    setSwitchFacingLabel();
  }
});

navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  void populateCameraOptions();
});

window.addEventListener("beforeunload", stopPreview);
