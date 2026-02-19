export type AppConfig = {
  confidenceThresholdName: number;
  confidenceThresholdSeat: number;
  scanTimeoutMs: number;
  retryIntervalMs: number;
  audioPlaybackRate: number;
  ocrBackendUrl: string;
};

const DEFAULT_CONFIG: AppConfig = {
  confidenceThresholdName: 0.8,
  confidenceThresholdSeat: 0.9,
  scanTimeoutMs: 1500,
  retryIntervalMs: 300,
  audioPlaybackRate: 1.0,
  ocrBackendUrl: "http://127.0.0.1:8000/ocr"
};

const clamp01 = (value: number): number => {
  if (Number.isNaN(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseUrl = (value: string | undefined, fallback: string): string => {
  if (!value) {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

export const appConfig: AppConfig = {
  confidenceThresholdName: clamp01(
    parseNumber(import.meta.env.VITE_CONFIDENCE_THRESHOLD_NAME, DEFAULT_CONFIG.confidenceThresholdName)
  ),
  confidenceThresholdSeat: clamp01(
    parseNumber(import.meta.env.VITE_CONFIDENCE_THRESHOLD_SEAT, DEFAULT_CONFIG.confidenceThresholdSeat)
  ),
  scanTimeoutMs: Math.max(0, parseNumber(import.meta.env.VITE_SCAN_TIMEOUT_MS, DEFAULT_CONFIG.scanTimeoutMs)),
  retryIntervalMs: Math.max(0, parseNumber(import.meta.env.VITE_RETRY_INTERVAL_MS, DEFAULT_CONFIG.retryIntervalMs)),
  audioPlaybackRate: Math.max(0.1, parseNumber(import.meta.env.VITE_AUDIO_PLAYBACK_RATE, DEFAULT_CONFIG.audioPlaybackRate)),
  ocrBackendUrl: parseUrl(import.meta.env.VITE_OCR_BACKEND_URL, DEFAULT_CONFIG.ocrBackendUrl)
};
