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
  SeatAudioVariant,
} from "./types";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app container");
}

const isChrome = /Chrome/.test(navigator.userAgent) && !/Edg|OPR/.test(navigator.userAgent);
const hasCameraApi = Boolean(navigator.mediaDevices?.getUserMedia);
const scanController = new ScanController("Ready");
const isDebugRoute = window.location.pathname.replace(/\/$/, "") === "/debug";
const autoStartContinuousScan = !isDebugRoute;
const debugCompareBackendUrl = "/debug/compare";

let latestOCRResult: OCRResult | null = null;
let latestOCRItems: OCRItem[] = [];
let latestRuntimeStatus: RuntimeStatus | null = null;
let latestConfirmedAudioResult: SeatAudioResult | null = null;
let preferredFacingMode: "user" | "environment" = "environment";
let selectedCameraId: string | null = null;
let cameraStream: MediaStream | null = null;
let isOCRInFlight = false;
let operatorAutoStartAttempted = false;
let activeSeatAudio: HTMLAudioElement | null = null;
let nameSeatDirectoryPromise: Promise<Map<string, string>> | null = null;
let runtimePollTimer: number | null = null;
let continuousScanEnabled = false;
let continuousScanTimer: number | null = null;
let lastContinuousAudioSeat: string | null = null;
let debugContinuousLatencyTotalMs = 0;
let debugContinuousLatencyCount = 0;
let debugMatchedContinuousLatencyTotalMs = 0;
let debugMatchedContinuousLatencyCount = 0;

const CONTINUOUS_SCAN_INTERVAL_MS = 1000;

const plannedAudioOutput: AudioResolution = {
  playbackRate: appConfig.audioPlaybackRate,
  segments: [],
};

const renderDebugApp = (): string => `
  <main class="shell">
    <header>
      <h1>OCR Ticket Reader</h1>
      <p>Webcam frame is sent to the local PaddleOCR backend, then name/seat are parsed in the browser.</p>
    </header>
    <section class="panel">
      <p><strong>Browser check:</strong> ${isChrome ? "Chrome detected" : "Please use desktop Chrome for camera scanning."}</p>
      <p><strong>Camera API:</strong> ${hasCameraApi ? "Available" : "Not available"}</p>
      <p><strong>Debug backend:</strong> <code>${debugCompareBackendUrl}</code></p>
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
      <p id="scan-mode-status"><strong>Scan mode:</strong> One click</p>

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
        <p id="latency-status"><strong>Latency:</strong> -</p>
        <p id="average-latency-status"><strong>Average latency in continuous scan (including no match):</strong> -</p>
        <p id="matched-average-latency-status"><strong>Average latency in continuous scan:</strong> -</p>
        <div class="audio-controls">
          <button id="male-audio-btn" type="button" disabled>Male Audio</button>
          <button id="female-audio-btn" type="button" disabled>Female Audio</button>
        </div>
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
        <button id="toggle-continuous-scan-btn" type="button" disabled>Start Continuous Scan</button>
        <button id="stop-camera-btn" type="button" disabled>Stop Camera</button>
        <button id="quit-app-btn" type="button" hidden disabled>Quit App</button>
      </div>
    </section>
  </main>
`;

const renderOperatorApp = (): string => `
  <main class="operator-shell">
    <section class="operator-camera">
      <div class="operator-preview-frame preview-frame">
        <video id="camera-preview" autoplay muted playsinline></video>
      </div>
      <p id="camera-message" class="operator-status">Connecting to the local OCR service...</p>
    </section>

    <section class="operator-result" aria-live="polite">
      <p id="operator-name" class="operator-name" hidden></p>
    </section>

    <div class="operator-actions">
      <button id="capture-ocr-btn" class="operator-button operator-button-primary" type="button" disabled>Read Again</button>
      <button id="male-audio-btn" class="operator-button" type="button" disabled>Male Audio</button>
      <button id="female-audio-btn" class="operator-button" type="button" disabled>Female Audio</button>
      <button id="quit-app-btn" class="operator-button" type="button" hidden disabled>Quit App</button>
    </div>

    <div class="app-hidden" aria-hidden="true">
      <span id="app-mode">Checking runtime...</span>
      <span id="backend-runtime">Checking runtime...</span>
      <p id="runtime-message">Connecting to the local OCR service...</p>
      <p id="app-state"><strong>App state:</strong> ${scanController.getState()}</p>
      <p id="ocr-summary"><strong>Latest OCR result:</strong> None</p>
      <p id="sample-status"><strong>OCR request:</strong> idle</p>
      <p id="scan-mode-status"><strong>Scan mode:</strong> One click</p>
      <select id="camera-select" disabled>
        <option value="">Default rear camera</option>
      </select>
      <button id="switch-facing-btn" type="button" disabled>Switch to Front Camera</button>
      <p id="result-name"><strong>Name:</strong> -</p>
      <p id="result-seat"><strong>Seat:</strong> -</p>
      <p id="result-confidence"><strong>Confidence:</strong> -</p>
      <p id="audio-seat"><strong>CSV seat:</strong> -</p>
      <p id="audio-status"><strong>Seat audio:</strong> idle</p>
      <p id="latency-status"><strong>Latency:</strong> -</p>
      <p id="average-latency-status"><strong>Average latency in continuous scan (including no match):</strong> -</p>
      <p id="matched-average-latency-status"><strong>Average latency in continuous scan:</strong> -</p>
      <p id="ocr-count"><strong>Lines:</strong> 0</p>
      <pre id="ocr-raw">[]</pre>
      <p id="backend-path"><strong>Backend path:</strong> -</p>
      <p id="backend-request"><strong>Request ID:</strong> -</p>
      <p id="backend-attempt"><strong>Attempt:</strong> -</p>
      <p id="backend-pass"><strong>Selected pass:</strong> -</p>
      <p id="parser-status"><strong>Parser status:</strong> -</p>
      <pre id="ocr-diagnostics">{}</pre>
      <button id="start-camera-btn" type="button" disabled>Enable Camera</button>
      <button id="toggle-continuous-scan-btn" type="button" disabled>Start Continuous Scan</button>
      <button id="stop-camera-btn" type="button" disabled>Stop Camera</button>
    </div>
  </main>
`;

app.innerHTML = isDebugRoute ? renderDebugApp() : renderOperatorApp();

const appStateElement = document.querySelector<HTMLParagraphElement>("#app-state");
const appModeElement = document.querySelector<HTMLSpanElement>("#app-mode");
const runtimeStateElement = document.querySelector<HTMLSpanElement>("#backend-runtime");
const runtimeMessageElement = document.querySelector<HTMLParagraphElement>("#runtime-message");
const cameraMessageElement = document.querySelector<HTMLParagraphElement>("#camera-message");
const sampleStatusElement = document.querySelector<HTMLParagraphElement>("#sample-status");
const scanModeStatusElement = document.querySelector<HTMLParagraphElement>("#scan-mode-status");
const ocrSummaryElement = document.querySelector<HTMLParagraphElement>("#ocr-summary");
const previewElement = document.querySelector<HTMLVideoElement>("#camera-preview");
const resultNameElement = document.querySelector<HTMLParagraphElement>("#result-name");
const resultSeatElement = document.querySelector<HTMLParagraphElement>("#result-seat");
const resultConfidenceElement = document.querySelector<HTMLParagraphElement>("#result-confidence");
const audioSeatElement = document.querySelector<HTMLParagraphElement>("#audio-seat");
const audioStatusElement = document.querySelector<HTMLParagraphElement>("#audio-status");
const latencyStatusElement = document.querySelector<HTMLParagraphElement>("#latency-status");
const averageLatencyStatusElement = document.querySelector<HTMLParagraphElement>("#average-latency-status");
const matchedAverageLatencyStatusElement = document.querySelector<HTMLParagraphElement>("#matched-average-latency-status");
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
const toggleContinuousScanButton = document.querySelector<HTMLButtonElement>("#toggle-continuous-scan-btn");
const stopCameraButton = document.querySelector<HTMLButtonElement>("#stop-camera-btn");
const quitAppButton = document.querySelector<HTMLButtonElement>("#quit-app-btn");
const operatorNameElement = document.querySelector<HTMLParagraphElement>("#operator-name");
const maleAudioButton = document.querySelector<HTMLButtonElement>("#male-audio-btn");
const femaleAudioButton = document.querySelector<HTMLButtonElement>("#female-audio-btn");

if (
  !appStateElement ||
  !appModeElement ||
  !runtimeStateElement ||
  !runtimeMessageElement ||
  !cameraMessageElement ||
  !sampleStatusElement ||
  !scanModeStatusElement ||
  !ocrSummaryElement ||
  !previewElement ||
  !resultNameElement ||
  !resultSeatElement ||
  !resultConfidenceElement ||
  !audioSeatElement ||
  !audioStatusElement ||
  !latencyStatusElement ||
  !averageLatencyStatusElement ||
  !matchedAverageLatencyStatusElement ||
  !maleAudioButton ||
  !femaleAudioButton ||
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
  !toggleContinuousScanButton ||
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

type OCRMode = "fast" | "accurate";

type NameLookupCandidate = {
  text: string;
  confidence: number;
};

type DebugCompareResponse = {
  error?: string;
  results?: {
    current_bottom_left_det_rec?: OCRItem[];
    detect_crop_rec?: OCRItem[];
  };
  comparison?: {
    faster_path?: string;
    higher_scored_path?: string;
    current_bottom_left_det_rec_score?: number;
    detect_crop_rec_score?: number;
    current_bottom_left_det_rec_is_complete?: boolean;
    detect_crop_rec_is_complete?: boolean;
    [key: string]: unknown;
  };
  profiling?: Record<string, unknown>;
  debug?: {
    request_id?: string;
    attempt_number?: number | null;
    attempt_dir?: string | null;
    strategies?: Record<string, unknown>;
    [key: string]: unknown;
  };
  service_state?: RuntimeStatus;
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

const setConfirmedOperatorResult = (displayName: string | null, audioResult: SeatAudioResult | null): void => {
  if (displayName && audioResult?.sourceUrl && audioResult.resolvedSeat) {
    latestConfirmedAudioResult = audioResult;
    if (operatorNameElement) {
      operatorNameElement.textContent = displayName;
      operatorNameElement.hidden = false;
    }
  } else {
    latestConfirmedAudioResult = null;
    if (operatorNameElement) {
      operatorNameElement.textContent = "";
      operatorNameElement.hidden = true;
    }
  }

  updateActionAvailability();
};

const updateScanModeStatus = (): void => {
  scanModeStatusElement.innerHTML = `<strong>Scan mode:</strong> ${
    continuousScanEnabled ? `Continuous (${CONTINUOUS_SCAN_INTERVAL_MS}ms)` : "One click"
  }`;
  toggleContinuousScanButton.textContent = continuousScanEnabled ? "Stop Continuous Scan" : "Start Continuous Scan";
};

const updateSeatAudioDisplay = (result: SeatAudioResult): void => {
  audioSeatElement.innerHTML = `<strong>CSV seat:</strong> ${result.resolvedSeat ?? "-"}`;
  audioStatusElement.innerHTML = `<strong>Seat audio:</strong> ${result.message}`;
};

const formatMilliseconds = (value: unknown): string => (typeof value === "number" ? `${value.toFixed(1)} ms` : "-");

const updateLatencyDisplay = (
  latencyMs: unknown,
  averageLatencyMs: number | null,
  matchedAverageLatencyMs: number | null,
): void => {
  latencyStatusElement.innerHTML = `<strong>Latency:</strong> ${formatMilliseconds(latencyMs)}`;
  averageLatencyStatusElement.innerHTML = `<strong>Average latency in continuous scan (including no match):</strong> ${
    averageLatencyMs === null ? "-" : `${averageLatencyMs.toFixed(1)} ms`
  }`;
  matchedAverageLatencyStatusElement.innerHTML = `<strong>Average latency in continuous scan:</strong> ${
    matchedAverageLatencyMs === null ? "-" : `${matchedAverageLatencyMs.toFixed(1)} ms`
  }`;
};

const getPackagedAssetHint = (): string | null => {
  if (!(latestRuntimeStatus?.packaged ?? false)) {
    return null;
  }

  return `Editable assets: ${latestRuntimeStatus.seat_assets_dir}`;
};

const withPackagedAssetHint = (message: string): string => {
  const assetHint = getPackagedAssetHint();
  if (!assetHint || message.includes(assetHint)) {
    return message;
  }

  return `${message}. ${assetHint}`;
};

const getPackagedNamesCsvSetupMessage = (): string | null => {
  if (!(latestRuntimeStatus?.packaged ?? false)) {
    return null;
  }

  return `add names.csv at ${latestRuntimeStatus.names_csv_path} and seat WAV files under ${latestRuntimeStatus.audio_assets_dir}`;
};

const stopSeatAudioPlayback = (): void => {
  if (!activeSeatAudio) {
    return;
  }

  activeSeatAudio.pause();
  activeSeatAudio.currentTime = 0;
  activeSeatAudio = null;
};

const clearContinuousScanTimer = (): void => {
  if (continuousScanTimer !== null) {
    window.clearTimeout(continuousScanTimer);
    continuousScanTimer = null;
  }
};

const disableContinuousScan = (): void => {
  continuousScanEnabled = false;
  clearContinuousScanTimer();
  lastContinuousAudioSeat = null;
  updateScanModeStatus();
};

const supportedNameSeatHeaders = new Set(["Seat No,Name", "Seat No,Chinese Name"]);

const normalizeNameLookupKey = (name: string): string => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

const parseNameSeatDirectory = (csvText: string): Map<string, string> => {
  const rows = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rows.length === 0) {
    throw new Error("names.csv is empty");
  }

  const header = rows[0].replace(/^\ufeff/, "");
  if (!supportedNameSeatHeaders.has(header)) {
    throw new Error(`Unexpected names.csv header: ${header}. Expected Seat No,Name`);
  }

  const directory = new Map<string, string>();

  for (const row of rows.slice(1)) {
    const separatorIndex = row.indexOf(",");
    if (separatorIndex <= 0 || separatorIndex === row.length - 1) {
      continue;
    }

    const seat = row.slice(0, separatorIndex).trim();
    const nameKey = normalizeNameLookupKey(row.slice(separatorIndex + 1));
    if (seat && nameKey) {
      directory.set(nameKey, seat);
    }
  }

  return directory;
};

const loadNameSeatDirectory = async (): Promise<Map<string, string>> => {
  const response = await fetch("/names.csv", { cache: "no-store" });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(responseText.trim() || `names.csv returned ${response.status}`);
  }

  return parseNameSeatDirectory(responseText);
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

type SeatAudioCandidate = {
  fileName: string;
  isFallback: boolean;
  sourceUrl: string;
};

const getSeatAudioFileName = (seatNumber: string, variant: SeatAudioVariant): string => {
  if (variant === "male") {
    return `${seatNumber}_M.wav`;
  }

  if (variant === "female") {
    return `${seatNumber}_F.wav`;
  }

  return `${seatNumber}.wav`;
};

const buildSeatAudioUrl = (fileName: string): string => `/audio/${encodeURIComponent(fileName)}`;

const buildSeatAudioCandidates = (seatNumber: string, variant: SeatAudioVariant): SeatAudioCandidate[] => {
  const legacyFileName = getSeatAudioFileName(seatNumber, "legacy");
  const legacyCandidate = {
    fileName: legacyFileName,
    isFallback: variant !== "legacy",
    sourceUrl: buildSeatAudioUrl(legacyFileName),
  };

  if (variant === "legacy") {
    return [legacyCandidate];
  }

  const variantFileName = getSeatAudioFileName(seatNumber, variant);
  return [
    {
      fileName: variantFileName,
      isFallback: false,
      sourceUrl: buildSeatAudioUrl(variantFileName),
    },
    legacyCandidate,
  ];
};

const playAudioCandidate = async (candidate: SeatAudioCandidate): Promise<HTMLAudioElement> => {
  const audio = new Audio(candidate.sourceUrl);
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
  } catch (error) {
    if (activeSeatAudio === audio) {
      activeSeatAudio = null;
    }
    throw error;
  }

  return audio;
};

const formatAudioCandidateList = (candidates: SeatAudioCandidate[]): string => {
  if (candidates.length === 1) {
    return candidates[0].fileName;
  }

  return `${candidates[0].fileName} or fallback ${candidates[1].fileName}`;
};

const createReadySeatAudioResult = (lookupName: string, resolvedSeat: string): SeatAudioResult => {
  const legacyFileName = getSeatAudioFileName(resolvedSeat, "legacy");
  return {
    lookupName,
    resolvedSeat,
    sourceUrl: buildSeatAudioUrl(legacyFileName),
    variant: "legacy",
    status: "ready",
    message: `ready (${legacyFileName})`,
  };
};

const playSeatAudioSource = async (
  audioResult: SeatAudioResult | null,
  variant: SeatAudioVariant,
): Promise<SeatAudioResult> => {
  if (!audioResult?.resolvedSeat) {
    stopSeatAudioPlayback();
    return {
      lookupName: audioResult?.lookupName ?? null,
      resolvedSeat: audioResult?.resolvedSeat ?? null,
      sourceUrl: audioResult?.sourceUrl ?? null,
      variant,
      status: "skipped",
      message: `skipped (${variant} audio unavailable)`,
    };
  }

  const candidates = buildSeatAudioCandidates(audioResult.resolvedSeat, variant);
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      await playAudioCandidate(candidate);
      return {
        lookupName: audioResult.lookupName,
        resolvedSeat: audioResult.resolvedSeat,
        sourceUrl: candidate.sourceUrl,
        variant,
        status: "playing",
        message: candidate.isFallback ? `playing fallback ${candidate.fileName}` : `playing ${candidate.fileName}`,
      };
    } catch (error) {
      lastError = error;
    }
  }

  const packagedSetupMessage = getPackagedNamesCsvSetupMessage();
  const candidateList = formatAudioCandidateList(candidates);
  const message = packagedSetupMessage
    ? `unable to play ${candidateList}; add it under ${latestRuntimeStatus?.audio_assets_dir}`
    : lastError instanceof Error
      ? `unable to play ${candidateList}; ${lastError.message}`
      : `unable to play ${candidateList}`;

  return {
    lookupName: audioResult.lookupName,
    resolvedSeat: audioResult.resolvedSeat,
    sourceUrl: candidates[0]?.sourceUrl ?? null,
    variant,
    status: "error",
    message: `error (${withPackagedAssetHint(message)})`,
  };
};

const playConfirmedSeatAudio = async (variant: Exclude<SeatAudioVariant, "legacy">): Promise<void> => {
  const playbackResult = await playSeatAudioSource(latestConfirmedAudioResult, variant);
  updateSeatAudioDisplay(playbackResult);
  if (!isDebugRoute && playbackResult.status !== "skipped") {
    setCameraMessage(playbackResult.message);
  }
};

const playResolvedLegacyAudio = async (audioResult: SeatAudioResult): Promise<SeatAudioResult> => {
  const playbackResult = await playSeatAudioSource(audioResult, "legacy");
  updateSeatAudioDisplay(playbackResult);
  return playbackResult;
};

const getNameLookupCandidates = (parsed: OCRResult | null, parserDebug: ParserDebug): NameLookupCandidate[] => {
  const candidates: NameLookupCandidate[] = [];
  if (parsed?.holderName.trim()) {
    candidates.push({ text: parsed.holderName.trim(), confidence: parsed.confidence.name });
  }

  for (const candidate of parserDebug.nameCandidates) {
    candidates.push({ text: candidate.text, confidence: candidate.confidence });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = normalizeNameLookupKey(candidate.text);
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
};

const resolveSeatAudioFromNameCandidates = async (
  candidates: NameLookupCandidate[],
): Promise<SeatAudioResult> => {
  if (candidates.length === 0) {
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
    const message = withPackagedAssetHint(error instanceof Error ? error.message : "Unable to load names.csv");
    return {
      lookupName: candidates[0].text,
      resolvedSeat: null,
      sourceUrl: null,
      status: "error",
      message: `error (${message})`,
    };
  }

  for (const candidate of candidates) {
    const resolvedSeat = directory.get(normalizeNameLookupKey(candidate.text)) ?? null;
    if (resolvedSeat) {
      return createReadySeatAudioResult(candidate.text, resolvedSeat);
    }
  }

  const confidentCandidate = candidates.find(
    (candidate) => candidate.confidence >= appConfig.confidenceThresholdName,
  );
  const lookupName = confidentCandidate?.text ?? candidates[0].text;
  return {
    lookupName,
    resolvedSeat: null,
    sourceUrl: null,
    status: "skipped",
    message: `skipped (no CSV match for ${lookupName})`,
  };
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
  const canPlayResolvedAudio = Boolean(latestConfirmedAudioResult?.sourceUrl);
  startCameraButton.disabled = !canStartCamera;
  captureOCRButton.disabled = isDebugRoute
    ? !cameraStream || isOCRInFlight || !isRuntimeReady() || continuousScanEnabled
    : isOCRInFlight || !isRuntimeReady() || !hasCameraApi || !isChrome || continuousScanEnabled;
  toggleContinuousScanButton.disabled = continuousScanEnabled
    ? !cameraStream
    : !cameraStream || isOCRInFlight || !isRuntimeReady();
  stopCameraButton.disabled = !cameraStream;
  cameraSelectElement.disabled = !cameraStream;
  switchFacingButton.disabled = !cameraStream;
  if (maleAudioButton) {
    maleAudioButton.disabled = !canPlayResolvedAudio;
  }
  if (femaleAudioButton) {
    femaleAudioButton.disabled = !canPlayResolvedAudio;
  }
  quitAppButton.hidden = !(latestRuntimeStatus?.packaged ?? false);
  quitAppButton.disabled = !(latestRuntimeStatus?.packaged ?? false);
  setSwitchFacingLabel();
  updateScanModeStatus();
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

  if (status.packaged && !status.names_csv_present) {
    runtimeMessage = `${runtimeMessage} Add names.csv at ${status.names_csv_path}. Put seat WAV files under ${status.audio_assets_dir}.`;
  }

  runtimeMessageElement.textContent = runtimeMessage;
  updateActionAvailability();
};

const syncRuntimeStatus = (status: RuntimeStatus): void => {
  latestRuntimeStatus = status;
  updateRuntimeDisplay(status);

  if (status.is_ready) {
    if (!isDebugRoute && !operatorAutoStartAttempted && !cameraStream) {
      operatorAutoStartAttempted = true;
      void startPreview();
    }

    if (status.packaged && !status.names_csv_present) {
      nameSeatDirectoryPromise = null;
      updateSeatAudioDisplay({
        lookupName: null,
        resolvedSeat: null,
        sourceUrl: null,
        status: "error",
        message: `error (${getPackagedNamesCsvSetupMessage() ?? "unable to preload names.csv"})`,
      });
      return;
    }

    void ensureNameSeatDirectory().catch(() => {
      updateSeatAudioDisplay({
        lookupName: null,
        resolvedSeat: null,
        sourceUrl: null,
        status: "error",
        message: `error (${withPackagedAssetHint("unable to preload names.csv")})`,
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

const buildOCRBackendUrl = (mode: OCRMode): string => {
  const url = new URL(appConfig.ocrBackendUrl, window.location.origin);
  url.searchParams.set("mode", mode);
  return url.toString();
};

const fetchOCRData = async (blob: Blob, mode: OCRMode): Promise<OCRResponse> => {
  const formData = new FormData();
  formData.append("file", blob, "frame.jpg");

  const timeoutMs = Math.max(500, appConfig.scanTimeoutMs);
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildOCRBackendUrl(mode), {
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

const fetchDebugCompareData = async (blob: Blob): Promise<DebugCompareResponse> => {
  const formData = new FormData();
  formData.append("file", blob, "frame.jpg");

  const timeoutMs = Math.max(500, appConfig.scanTimeoutMs);
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(debugCompareBackendUrl, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    let data: DebugCompareResponse | null = null;
    try {
      data = (await response.json()) as DebugCompareResponse;
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
          : `OCR debug backend returned ${response.status}`;
      throw new Error(message);
    }

    if (data === null) {
      throw new Error("OCR debug backend returned an unreadable response.");
    }

    if (typeof data.error === "string" && data.error.trim().length > 0) {
      throw new Error(`OCR debug backend error: ${data.error}`);
    }

    return data;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const formatDebugStrategyLabel = (value: string | undefined): string => {
  if (!value) {
    return "-";
  }

  return value.replace(/_/g, " ");
};

const updateDebugCompareDisplay = (response: DebugCompareResponse): void => {
  const currentItems = response.results?.current_bottom_left_det_rec ?? [];
  const detectedItems = response.results?.detect_crop_rec ?? [];
  const comparison = response.comparison ?? {};
  const higherScoredPath = formatDebugStrategyLabel(comparison.higher_scored_path);
  const requestId = response.debug?.request_id ?? "-";
  const attemptNumber = response.debug?.attempt_number;
  const attemptDir = response.debug?.attempt_dir;

  latestOCRItems = detectedItems;
  latestOCRResult = null;

  ocrSummaryElement.innerHTML = "<strong>Latest OCR result:</strong> Debug comparison";
  ocrCountElement.innerHTML = `<strong>Lines:</strong> current ${currentItems.length}, detect-crop-rec ${detectedItems.length}`;
  ocrRawElement.textContent = JSON.stringify(response.results ?? {}, null, 2);
  backendPathElement.innerHTML = `<strong>Backend path:</strong> ${String(response.profiling?.path ?? "-")}`;
  backendRequestElement.innerHTML = `<strong>Request ID:</strong> ${requestId}`;
  backendAttemptElement.innerHTML = `<strong>Attempt:</strong> ${
    attemptNumber && attemptDir ? `${attemptNumber} (${attemptDir})` : "-"
  }`;
  backendPassElement.innerHTML = `<strong>Selected pass:</strong> ${higherScoredPath}`;
  parserStatusElement.innerHTML = `<strong>Parser status:</strong> current ${
    comparison.current_bottom_left_det_rec_is_complete ? "complete" : "incomplete"
  }, detect-crop-rec ${comparison.detect_crop_rec_is_complete ? "complete" : "incomplete"}`;
  ocrDiagnosticsElement.textContent = JSON.stringify(
    {
      comparison,
      profiling: response.profiling ?? null,
      debug: response.debug ?? null,
      serviceState: response.service_state ?? latestRuntimeStatus ?? null,
    },
    null,
    2,
  );
};

const getSelectedNameCandidate = (parsed: OCRResult | null, parserDebug: ParserDebug): Candidate | null => {
  if (parsed?.holderName.trim()) {
    return { text: parsed.holderName.trim(), confidence: parsed.confidence.name, index: -1 };
  }

  return parserDebug.selectedName;
};

const getSelectedSeatCandidate = (parsed: OCRResult | null, parserDebug: ParserDebug): Candidate | null => {
  if (parsed?.seatNumber.trim()) {
    return { text: parsed.seatNumber.trim(), confidence: parsed.confidence.seat, index: -1 };
  }

  return parserDebug.selectedSeat;
};

const findNameCandidateConfidence = (
  lookupName: string | null,
  candidates: NameLookupCandidate[],
): number | null => {
  if (!lookupName) {
    return null;
  }

  const lookupKey = normalizeNameLookupKey(lookupName);
  return candidates.find((candidate) => normalizeNameLookupKey(candidate.text) === lookupKey)?.confidence ?? null;
};

const updateDebugParsedResultDisplay = (
  preferredParsed: { result: OCRResult | null; debug: ParserDebug },
  secondaryParsed: { result: OCRResult | null; debug: ParserDebug },
  seatAudioResult: SeatAudioResult,
  nameCandidates: NameLookupCandidate[],
): void => {
  const preferredName = getSelectedNameCandidate(preferredParsed.result, preferredParsed.debug);
  const secondaryName = getSelectedNameCandidate(secondaryParsed.result, secondaryParsed.debug);
  const preferredSeat = getSelectedSeatCandidate(preferredParsed.result, preferredParsed.debug);
  const secondarySeat = getSelectedSeatCandidate(secondaryParsed.result, secondaryParsed.debug);
  const displayName = seatAudioResult.lookupName ?? preferredName?.text ?? secondaryName?.text ?? null;
  const displaySeat = seatAudioResult.resolvedSeat ?? preferredSeat?.text ?? secondarySeat?.text ?? null;
  const nameConfidence =
    findNameCandidateConfidence(seatAudioResult.lookupName, nameCandidates) ??
    preferredName?.confidence ??
    secondaryName?.confidence;
  const seatConfidence = preferredSeat?.confidence ?? secondarySeat?.confidence;
  const combinedConfidence =
    nameConfidence !== undefined && nameConfidence !== null && seatConfidence !== undefined
      ? Math.min(nameConfidence, seatConfidence)
      : undefined;

  resultNameElement.innerHTML = `<strong>Name:</strong> ${displayName ?? "-"}`;
  resultSeatElement.innerHTML = `<strong>Seat:</strong> ${displaySeat ?? "-"}`;
  resultConfidenceElement.innerHTML = `<strong>Confidence:</strong> name ${
    nameConfidence !== undefined && nameConfidence !== null ? nameConfidence.toFixed(2) : "-"
  }, seat ${seatConfidence !== undefined ? seatConfidence.toFixed(2) : "-"}, combined ${
    combinedConfidence !== undefined ? combinedConfidence.toFixed(2) : "-"
  }`;
};

const scheduleContinuousScan = (): void => {
  if (!continuousScanEnabled) {
    return;
  }

  clearContinuousScanTimer();
  continuousScanTimer = window.setTimeout(() => {
    void captureAndSendOCR({ initiatedByContinuousScan: true });
  }, CONTINUOUS_SCAN_INTERVAL_MS);
};

const setContinuousScanEnabled = (enabled: boolean): void => {
  if (!enabled) {
    disableContinuousScan();
    updateActionAvailability();
    return;
  }

  if (!cameraStream || !isRuntimeReady()) {
    setCameraMessage("Continuous scan requires an active camera preview and ready OCR runtime.");
    updateActionAvailability();
    return;
  }

  continuousScanEnabled = true;
  clearContinuousScanTimer();
  lastContinuousAudioSeat = null;
    if (isDebugRoute) {
      debugContinuousLatencyTotalMs = 0;
      debugContinuousLatencyCount = 0;
      debugMatchedContinuousLatencyTotalMs = 0;
      debugMatchedContinuousLatencyCount = 0;
      updateLatencyDisplay(null, null, null);
    }
  setCameraMessage("Continuous scan active. Capturing one frame every second.");
  updateActionAvailability();
  void captureAndSendOCR({ initiatedByContinuousScan: true });
};

const captureAndSendDebugCompare = async (
  options: { initiatedByContinuousScan?: boolean } = {}
): Promise<void> => {
  const initiatedByContinuousScan = options.initiatedByContinuousScan ?? false;

  if (!cameraStream || isOCRInFlight) {
    if (initiatedByContinuousScan && continuousScanEnabled) {
      scheduleContinuousScan();
    }
    return;
  }

  if (!isRuntimeReady()) {
    setCameraMessage(latestRuntimeStatus?.message ?? "OCR runtime is not ready yet.");
    if (initiatedByContinuousScan && continuousScanEnabled) {
      scheduleContinuousScan();
    }
    return;
  }

  const blob = await captureFrameBlob();
  if (!blob) {
    setCameraMessage("No video frame available yet. Wait for the preview to load and try again.");
    if (initiatedByContinuousScan && continuousScanEnabled) {
      scheduleContinuousScan();
    }
    return;
  }

  scanController.setState("Scanning");
  isOCRInFlight = true;
  updateActionAvailability();
  setSampleStatus("sending debug comparison");
  setConfirmedOperatorResult(null, null);
  stopSeatAudioPlayback();
  updateSeatAudioDisplay({
    lookupName: null,
    resolvedSeat: null,
    sourceUrl: null,
    status: "skipped",
    message: "skipped (debug comparison)",
  });

  try {
    const response = await fetchDebugCompareData(blob);
    const currentComplete = response.comparison?.current_bottom_left_det_rec_is_complete ?? false;
    const detectedComplete = response.comparison?.detect_crop_rec_is_complete ?? false;
    const preferredDebugItems =
      response.comparison?.higher_scored_path === "current_bottom_left_det_rec"
        ? response.results?.current_bottom_left_det_rec ?? []
        : response.results?.detect_crop_rec ?? [];
    const secondaryDebugItems =
      response.comparison?.higher_scored_path === "current_bottom_left_det_rec"
        ? response.results?.detect_crop_rec ?? []
        : response.results?.current_bottom_left_det_rec ?? [];
    const preferredParsed = parseResultFromOCRItems(preferredDebugItems);
    const secondaryParsed = parseResultFromOCRItems(secondaryDebugItems);
    const nameCandidates = [
      ...getNameLookupCandidates(preferredParsed.result, preferredParsed.debug),
      ...getNameLookupCandidates(secondaryParsed.result, secondaryParsed.debug),
    ];
    const seatAudioResult = await resolveSeatAudioFromNameCandidates(nameCandidates);
    const hasConfirmedCsvName = Boolean(seatAudioResult.lookupName && seatAudioResult.resolvedSeat);
    const latencyMs = response.profiling?.total_ms;
    if (initiatedByContinuousScan && typeof latencyMs === "number") {
      debugContinuousLatencyTotalMs += latencyMs;
      debugContinuousLatencyCount += 1;
      if (hasConfirmedCsvName) {
        debugMatchedContinuousLatencyTotalMs += latencyMs;
        debugMatchedContinuousLatencyCount += 1;
      }
    }
    const averageLatencyMs =
      debugContinuousLatencyCount > 0 ? debugContinuousLatencyTotalMs / debugContinuousLatencyCount : null;
    const matchedAverageLatencyMs =
      debugMatchedContinuousLatencyCount > 0
        ? debugMatchedContinuousLatencyTotalMs / debugMatchedContinuousLatencyCount
        : null;

    scanController.setState(hasConfirmedCsvName || currentComplete || detectedComplete ? "Recognized" : "RetryNeeded");
    updateDebugCompareDisplay(response);
    updateDebugParsedResultDisplay(preferredParsed, secondaryParsed, seatAudioResult, nameCandidates);
    updateLatencyDisplay(latencyMs, averageLatencyMs, matchedAverageLatencyMs);
    if (hasConfirmedCsvName && seatAudioResult.lookupName) {
      setConfirmedOperatorResult(seatAudioResult.lookupName, seatAudioResult);
      await playResolvedLegacyAudio(seatAudioResult);
    } else {
      setConfirmedOperatorResult(null, null);
      updateSeatAudioDisplay(seatAudioResult);
    }
    setSampleStatus("completed debug comparison");
    setCameraMessage("Debug comparison complete.");
  } catch (error) {
    scanController.setState("RetryNeeded");
    updateDiagnosticsDisplay(null, null);
    if (error instanceof DOMException && error.name === "AbortError") {
      setCameraMessage(`OCR debug request timed out after ${Math.max(500, appConfig.scanTimeoutMs)}ms.`);
    } else {
      setCameraMessage(
        error instanceof Error ? `OCR debug request failed: ${error.message}` : "OCR debug request failed."
      );
    }
    setSampleStatus("failed");
  } finally {
    isOCRInFlight = false;
    updateActionAvailability();
    if (initiatedByContinuousScan && continuousScanEnabled && cameraStream) {
      scheduleContinuousScan();
    }
  }
};

const captureAndSendOCR = async (
  options: { initiatedByContinuousScan?: boolean } = {}
): Promise<void> => {
  if (isDebugRoute) {
    await captureAndSendDebugCompare(options);
    return;
  }

  const initiatedByContinuousScan = options.initiatedByContinuousScan ?? false;
  if (!cameraStream && !isDebugRoute && !isOCRInFlight) {
    await startPreview();
  }

  if (!cameraStream || isOCRInFlight) {
    if (initiatedByContinuousScan && continuousScanEnabled) {
      scheduleContinuousScan();
    }
    return;
  }

  if (!isRuntimeReady()) {
    setCameraMessage(latestRuntimeStatus?.message ?? "OCR runtime is not ready yet.");
    if (initiatedByContinuousScan && continuousScanEnabled) {
      scheduleContinuousScan();
    }
    return;
  }

  const blob = await captureFrameBlob();
  if (!blob) {
    setCameraMessage("No video frame available yet. Wait for the preview to load and try again.");
    if (initiatedByContinuousScan && continuousScanEnabled) {
      scheduleContinuousScan();
    }
    return;
  }

  scanController.setState("Scanning");
  isOCRInFlight = true;
  updateActionAvailability();
  setSampleStatus("sending");
  if (!initiatedByContinuousScan) {
    setConfirmedOperatorResult(null, null);
    stopSeatAudioPlayback();
  }

  try {
    const response = await fetchOCRData(blob, initiatedByContinuousScan ? "fast" : "accurate");
    const items = Array.isArray(response.results) ? response.results : [];
    const { result: parsed, debug: parserDebug } = parseResultFromOCRItems(items);
    const seatAudioResult = await resolveSeatAudioFromNameCandidates(getNameLookupCandidates(parsed, parserDebug));
    const hasConfirmedCsvName = Boolean(seatAudioResult.lookupName && seatAudioResult.resolvedSeat);
    if (hasConfirmedCsvName && seatAudioResult.lookupName) {
      setConfirmedOperatorResult(seatAudioResult.lookupName, seatAudioResult);
      if (initiatedByContinuousScan && seatAudioResult.resolvedSeat) {
        lastContinuousAudioSeat = seatAudioResult.resolvedSeat;
      } else if (!initiatedByContinuousScan) {
        lastContinuousAudioSeat = null;
      }
    } else {
      if (!initiatedByContinuousScan) {
        setConfirmedOperatorResult(null, null);
        lastContinuousAudioSeat = null;
      }
    }

    scanController.setState(hasConfirmedCsvName ? "Recognized" : "RetryNeeded");

    updateOCRDisplay(items, parsed, parserDebug);
    if (hasConfirmedCsvName || !initiatedByContinuousScan) {
      updateSeatAudioDisplay(seatAudioResult);
    }
    updateDiagnosticsDisplay(response, parserDebug);
    setSampleStatus(`completed (${items.length} OCR lines)`);
    if (isDebugRoute) {
      setCameraMessage(
        initiatedByContinuousScan ? "Continuous scan active. Latest frame sent to OCR." : "Capture sent to OCR."
      );
    } else {
      setCameraMessage(hasConfirmedCsvName ? "Read successful." : "No matched name.");
    }
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
    if (initiatedByContinuousScan && continuousScanEnabled && cameraStream) {
      scheduleContinuousScan();
    }
  }
};

const stopPreview = (): void => {
  isOCRInFlight = false;
  disableContinuousScan();
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
  setConfirmedOperatorResult(null, null);
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
    if (autoStartContinuousScan) {
      setContinuousScanEnabled(true);
    } else {
      setCameraMessage("Camera preview active. Use one-click capture or start continuous scan.");
      updateActionAvailability();
    }
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
updateLatencyDisplay(null, null, null);
updateScanModeStatus();
void updateCameraControlsState();
void refreshRuntimeStatus();

startCameraButton.addEventListener("click", () => {
  void startPreview();
});

captureOCRButton.addEventListener("click", () => {
  void captureAndSendOCR();
});

maleAudioButton?.addEventListener("click", () => {
  void playConfirmedSeatAudio("male");
});

femaleAudioButton?.addEventListener("click", () => {
  void playConfirmedSeatAudio("female");
});

toggleContinuousScanButton.addEventListener("click", () => {
  setContinuousScanEnabled(!continuousScanEnabled);
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
  clearContinuousScanTimer();
  stopPreview();
});
