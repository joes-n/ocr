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

export type OCRItem = {
  box: Array<[number, number]>;
  text: string;
  confidence: number;
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
