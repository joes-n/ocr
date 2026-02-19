import type { TicketBoundingBox, TicketLocalizationResult } from "./ticket_localizer_2";

export type Point2D = {
  x: number;
  y: number;
};

export type TicketQuad = {
  topLeft: Point2D;
  topRight: Point2D;
  bottomRight: Point2D;
  bottomLeft: Point2D;
};

export type TicketRotationVariant = {
  rotationDegrees: 0 | 90 | 180 | 270;
  canvas: HTMLCanvasElement;
};

export type TicketNormalizationMethod = "unavailable";

export type TicketNormalizationResult = {
  success: boolean;
  canvas: HTMLCanvasElement | null;
  estimatedAngleDegrees: number;
  appliedRotationDegrees: number;
  variants: TicketRotationVariant[];
  method: TicketNormalizationMethod;
  quad: TicketQuad | null;
  warpConfidence: number;
};

export type TicketNormalizerOptions = {
  paddingRatio?: number;
  includeRotationVariants?: boolean;
};

export type LabelNormalizationMethod = "unavailable";

export type LabelNormalizationResult = {
  success: boolean;
  canvas: HTMLCanvasElement | null;
  method: LabelNormalizationMethod;
  sourceBox: TicketBoundingBox | null;
};

export type LabelNormalizerOptions = {
  paddingRatio?: number;
  targetWidth?: number;
  targetHeight?: number;
};

export const normalizeTicketOrientationFromVideoFrame = (
  _sourceVideo: HTMLVideoElement,
  _localization: TicketLocalizationResult,
  _options: TicketNormalizerOptions = {}
): TicketNormalizationResult => ({
  success: false,
  canvas: null,
  estimatedAngleDegrees: 0,
  appliedRotationDegrees: 0,
  variants: [],
  method: "unavailable",
  quad: null,
  warpConfidence: 0
});

export const normalizeLabelFromVideoFrame = (
  _sourceVideo: HTMLVideoElement,
  localization: TicketLocalizationResult,
  _options: LabelNormalizerOptions = {}
): LabelNormalizationResult => ({
  success: false,
  canvas: null,
  method: "unavailable",
  sourceBox: localization.labelBox ?? localization.ticketBox ?? localization.box
});
