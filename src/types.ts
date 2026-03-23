export type AppState = "Ready" | "Scanning" | "Recognized" | "RetryNeeded";

export type OCRFieldConfidence = {
  name: number;
  seat: number;
  combined: number;
};

export type OCRResult = {
  holderName: string;
  seatNumber: string;
  confidence: OCRFieldConfidence;
};

export type OCRProfiling = {
  path?: string;
  decode_ms?: number;
  label_detect_ms?: number;
  crop_ms?: number;
  seg_ms?: number;
  ocr_ms?: number;
  total_ms?: number;
};

export type OCRItem = {
  box: Array<[number, number]>;
  text: string;
  confidence: number;
};

export type OCRDebug = {
  request_id?: string;
  attempt_number?: number | null;
  attempt_dir?: string | null;
  artifacts_dir?: string | null;
  image_shape?: { width: number; height: number };
  artifacts?: Record<string, unknown>;
  label_detection?: {
    selected_pass?: string | null;
    selected_bbox?: { x: number; y: number; w: number; h: number } | null;
    selected_candidate?: Record<string, unknown> | null;
    validation_attempts?: Record<string, unknown>[];
    [key: string]: unknown;
  };
  segmentation?: Record<string, unknown> | null;
  output_count?: number;
  output_preview?: OCRItem[];
};

export type OCRResponse = {
  error?: string;
  results?: OCRItem[];
  profiling?: OCRProfiling;
  debug?: OCRDebug;
};

export type AudioSourceType = "preRecorded" | "tts";

export type AudioSegment = {
  label: "name" | "seat";
  text: string;
  sourceType: AudioSourceType;
  sourceId: string;
};

export type AudioResolution = {
  playbackRate: number;
  segments: AudioSegment[];
};

export type SeatAudioStatus = "idle" | "playing" | "skipped" | "error";

export type SeatAudioResult = {
  lookupName: string | null;
  resolvedSeat: string | null;
  sourceUrl: string | null;
  status: SeatAudioStatus;
  message: string;
};
