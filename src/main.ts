import "./styles.css";
import { appConfig } from "./config";
import { ScanController } from "./scan-controller";
import { localizeTicketFromVideoFrame } from "./ticket-localizer";
import { normalizeTicketOrientationFromVideoFrame } from "./ticket-normalizer";
import type { AudioResolution, OCRResult } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app container");
}

const isChrome = /Chrome/.test(navigator.userAgent) && !/Edg|OPR/.test(navigator.userAgent);
const hasCameraApi = Boolean(navigator.mediaDevices?.getUserMedia);
const scanController = new ScanController("Ready");
const frameSampleIntervalMs = appConfig.retryIntervalMs;

const latestOCRResult: OCRResult | null = null;
let preferredFacingMode: "user" | "environment" = "environment";
let selectedCameraId: string | null = null;

const plannedAudioOutput: AudioResolution = {
  playbackRate: appConfig.audioPlaybackRate,
  segments: []
};

app.innerHTML = `
  <main class="shell">
    <header>
      <h1>OCR Ticket Reader</h1>
      <p>MVP scaffold initialized for desktop Chrome.</p>
    </header>
    <section class="panel">
      <p><strong>Browser check:</strong> ${isChrome ? "Chrome detected" : "Please use desktop Chrome for MVP."}</p>
      <p><strong>Camera API:</strong> ${hasCameraApi ? "Available" : "Not available"}</p>
      <p><strong>Name confidence threshold:</strong> ${appConfig.confidenceThresholdName}</p>
      <p><strong>Seat confidence threshold:</strong> ${appConfig.confidenceThresholdSeat}</p>
      <p><strong>Scan timeout (ms):</strong> ${appConfig.scanTimeoutMs}</p>
      <p><strong>Retry interval (ms):</strong> ${appConfig.retryIntervalMs}</p>
      <p><strong>Frame sample interval (ms):</strong> ${frameSampleIntervalMs}</p>
      <p><strong>Audio playback rate:</strong> ${appConfig.audioPlaybackRate}</p>
      <p id="app-state"><strong>App state:</strong> ${scanController.getState()}</p>
      <p><strong>Latest OCR result:</strong> ${latestOCRResult ? "Available" : "None"}</p>
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
        <div id="ticket-overlay" class="ticket-overlay hidden"></div>
        <div id="label-overlay" class="label-overlay hidden"></div>
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
const previewElement = document.querySelector<HTMLVideoElement>("#camera-preview");
const ticketOverlayElement = document.querySelector<HTMLDivElement>("#ticket-overlay");
const labelOverlayElement = document.querySelector<HTMLDivElement>("#label-overlay");
const cameraSelectElement = document.querySelector<HTMLSelectElement>("#camera-select");
const switchFacingButton = document.querySelector<HTMLButtonElement>("#switch-facing-btn");
const startCameraButton = document.querySelector<HTMLButtonElement>("#start-camera-btn");
const stopCameraButton = document.querySelector<HTMLButtonElement>("#stop-camera-btn");

if (
  !appStateElement ||
  !cameraMessageElement ||
  !sampleStatusElement ||
  !previewElement ||
  !ticketOverlayElement ||
  !labelOverlayElement ||
  !cameraSelectElement ||
  !switchFacingButton ||
  !startCameraButton ||
  !stopCameraButton
) {
  throw new Error("Missing camera preview elements");
}

let cameraStream: MediaStream | null = null;
let samplingTimerId: number | null = null;
let sampleCount = 0;
let normalizedFrameCount = 0;
const sampleCanvas = document.createElement("canvas");
const sampleContext = sampleCanvas.getContext("2d");

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
    cameraSelectElement.innerHTML = `<option value=\"\">Default camera</option>`;
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter((device) => device.kind === "videoinput");

  if (videoDevices.length === 0) {
    cameraSelectElement.innerHTML = `<option value=\"\">No camera devices detected</option>`;
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

  if (selectedCameraId) {
    cameraSelectElement.value = selectedCameraId;
  } else {
    cameraSelectElement.value = "";
  }
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

const setAppState = (stateLabel: string): void => {
  appStateElement.innerHTML = `<strong>App state:</strong> ${stateLabel}`;
};

const setCameraMessage = (message: string): void => {
  cameraMessageElement.textContent = message;
};

const setSampleStatus = (message: string): void => {
  sampleStatusElement.innerHTML = `<strong>Sample loop:</strong> ${message}`;
};

const hideTicketOverlays = (): void => {
  ticketOverlayElement.classList.add("hidden");
  labelOverlayElement.classList.add("hidden");
};

const renderOverlay = (
  overlayElement: HTMLDivElement,
  box: { x: number; y: number; width: number; height: number } | null,
  frameWidth: number,
  frameHeight: number
): void => {
  if (!box || frameWidth <= 0 || frameHeight <= 0) {
    overlayElement.classList.add("hidden");
    return;
  }

  const xPercent = (box.x / frameWidth) * 100;
  const yPercent = (box.y / frameHeight) * 100;
  const widthPercent = (box.width / frameWidth) * 100;
  const heightPercent = (box.height / frameHeight) * 100;

  overlayElement.style.left = `${xPercent}%`;
  overlayElement.style.top = `${yPercent}%`;
  overlayElement.style.width = `${widthPercent}%`;
  overlayElement.style.height = `${heightPercent}%`;
  overlayElement.classList.remove("hidden");
};

const renderTicketOverlays = (
  localization: ReturnType<typeof localizeTicketFromVideoFrame>,
  frameWidth: number,
  frameHeight: number
): void => {
  if (!localization.ticketFound || frameWidth <= 0 || frameHeight <= 0) {
    hideTicketOverlays();
    return;
  }

  renderOverlay(ticketOverlayElement, localization.ticketBox ?? localization.box, frameWidth, frameHeight);
  renderOverlay(labelOverlayElement, localization.labelFound ? localization.labelBox : null, frameWidth, frameHeight);
};

scanController.subscribe(setAppState);

const stopSampling = (): void => {
  if (samplingTimerId !== null) {
    window.clearInterval(samplingTimerId);
    samplingTimerId = null;
  }

  sampleCount = 0;
  normalizedFrameCount = 0;
  setSampleStatus("idle");
};

const sampleFrame = (): void => {
  if (!sampleContext || !cameraStream) {
    return;
  }

  const width = previewElement.videoWidth;
  const height = previewElement.videoHeight;

  if (width <= 0 || height <= 0) {
    return;
  }

  if (sampleCanvas.width !== width) {
    sampleCanvas.width = width;
  }

  if (sampleCanvas.height !== height) {
    sampleCanvas.height = height;
  }

  sampleContext.drawImage(previewElement, 0, 0, width, height);
  const localization = localizeTicketFromVideoFrame(previewElement, { debug: true });
  renderTicketOverlays(localization, width, height);

  let pipelineDetails = "";
  if (localization.ticketFound) {
    const normalizedTicket = normalizeTicketOrientationFromVideoFrame(previewElement, localization);
    if (normalizedTicket.success && normalizedTicket.canvas) {
      normalizedFrameCount += 1;
      pipelineDetails = `, normalized ${normalizedFrameCount}, ticket roi ${normalizedTicket.canvas.width}x${normalizedTicket.canvas.height}, rotation ${normalizedTicket.appliedRotationDegrees.toFixed(1)}deg, method ${normalizedTicket.method}, warp ${normalizedTicket.warpConfidence.toFixed(2)}`;
    }
  }

  const debugDetails = localization.debug
    ? `, flags t:${localization.ticketFound ? "1" : "0"} l:${localization.labelFound ? "1" : "0"}, stage ${localization.debug.stage}, ticket ${localization.debug.ticketScore.toFixed(2)}, label ${localization.debug.labelScore.toFixed(2)}, light ${localization.debug.frameLighting}`
    : "";
  const missReasons =
    localization.debug && (!localization.ticketFound || !localization.labelFound) && localization.debug.reasons.length > 0
      ? `, reasons ${localization.debug.reasons.slice(0, 4).join("|")}`
      : "";

  sampleCount += 1;
  setSampleStatus(
    localization.ticketFound
      ? `running (${sampleCount} samples, ticket confidence ${localization.confidence.toFixed(2)}${debugDetails}${pipelineDetails})`
      : `running (${sampleCount} samples, searching ticket${debugDetails}${missReasons})`
  );
};

const startSampling = (): void => {
  stopSampling();
  setSampleStatus("starting");
  samplingTimerId = window.setInterval(sampleFrame, frameSampleIntervalMs);
};

const stopPreview = (): void => {
  stopSampling();
  hideTicketOverlays();

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
    const activeDeviceId = activeSettings?.deviceId;
    if (activeDeviceId) {
      selectedCameraId = activeDeviceId;
    }

    if (activeTrack?.label) {
      const inferred = inferFacingModeFromLabel(activeTrack.label);
      if (inferred) {
        preferredFacingMode = inferred;
      }
    }

    await populateCameraOptions();

    scanController.setState("Scanning");
    setCameraMessage("Camera preview active.");
    sampleCount = 0;
    startSampling();
    stopCameraButton.disabled = false;
    updateCameraControlsState(true);
  } catch (error) {
    stopSampling();
    hideTicketOverlays();
    scanController.setState("RetryNeeded");
    startCameraButton.disabled = false;
    updateCameraControlsState(hasCameraApi && isChrome);
    setCameraMessage(
      error instanceof Error ? `Unable to start camera: ${error.message}` : "Unable to start camera."
    );
  }
};

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
