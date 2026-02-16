import type { TicketLocalizationResult } from "./ticket-localizer";

export type TicketRotationVariant = {
  rotationDegrees: 0 | 90 | 180 | 270;
  canvas: HTMLCanvasElement;
};

export type TicketNormalizationResult = {
  success: boolean;
  canvas: HTMLCanvasElement | null;
  estimatedAngleDegrees: number;
  appliedRotationDegrees: number;
  variants: TicketRotationVariant[];
};

export type TicketNormalizerOptions = {
  paddingRatio?: number;
  includeRotationVariants?: boolean;
};

const MAX_PADDING_RATIO = 0.25;
const DEFAULT_PADDING_RATIO = 0.08;
const MIN_EDGE_POINTS = 180;
const MIN_ANISOTROPY = 0.08;

const frameCanvas = document.createElement("canvas");
const frameContext = frameCanvas.getContext("2d", { willReadFrequently: true });
const cropCanvas = document.createElement("canvas");
const cropContext = cropCanvas.getContext("2d", { willReadFrequently: true });

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const radiansToDegrees = (radians: number): number => (radians * 180) / Math.PI;

const rotateCanvas = (source: HTMLCanvasElement, radians: number): HTMLCanvasElement => {
  const width = source.width;
  const height = source.height;
  const absCos = Math.abs(Math.cos(radians));
  const absSin = Math.abs(Math.sin(radians));
  const rotatedWidth = Math.max(1, Math.ceil(width * absCos + height * absSin));
  const rotatedHeight = Math.max(1, Math.ceil(width * absSin + height * absCos));

  const output = document.createElement("canvas");
  output.width = rotatedWidth;
  output.height = rotatedHeight;
  const context = output.getContext("2d");
  if (!context) {
    return output;
  }

  context.translate(rotatedWidth / 2, rotatedHeight / 2);
  context.rotate(radians);
  context.drawImage(source, -width / 2, -height / 2);
  return output;
};

const computeDominantAxisAngle = (canvas: HTMLCanvasElement): number => {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || canvas.width < 3 || canvas.height < 3) {
    return 0;
  }

  const { width, height } = canvas;
  const imageData = context.getImageData(0, 0, width, height);
  const data = imageData.data;
  const luminance = new Float32Array(width * height);

  for (let index = 0; index < luminance.length; index += 1) {
    const pixelOffset = index * 4;
    const red = data[pixelOffset];
    const green = data[pixelOffset + 1];
    const blue = data[pixelOffset + 2];
    luminance[index] = 0.299 * red + 0.587 * green + 0.114 * blue;
  }

  const magnitudes: Array<{ x: number; y: number; weight: number }> = [];
  let magnitudeSum = 0;
  let magnitudeSumSq = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const topLeft = luminance[(y - 1) * width + (x - 1)];
      const top = luminance[(y - 1) * width + x];
      const topRight = luminance[(y - 1) * width + (x + 1)];
      const left = luminance[y * width + (x - 1)];
      const right = luminance[y * width + (x + 1)];
      const bottomLeft = luminance[(y + 1) * width + (x - 1)];
      const bottom = luminance[(y + 1) * width + x];
      const bottomRight = luminance[(y + 1) * width + (x + 1)];

      const gx = -topLeft + topRight - (left * 2) + (right * 2) - bottomLeft + bottomRight;
      const gy = -topLeft - (top * 2) - topRight + bottomLeft + (bottom * 2) + bottomRight;
      const magnitude = Math.abs(gx) + Math.abs(gy);

      magnitudes.push({ x, y, weight: magnitude });
      magnitudeSum += magnitude;
      magnitudeSumSq += magnitude * magnitude;
    }
  }

  if (magnitudes.length === 0) {
    return 0;
  }

  const mean = magnitudeSum / magnitudes.length;
  const stdDev = Math.sqrt(Math.max(0, magnitudeSumSq / magnitudes.length - mean * mean));
  const threshold = mean + stdDev * 0.8;

  let pointCount = 0;
  let weightTotal = 0;
  let meanX = 0;
  let meanY = 0;

  for (const point of magnitudes) {
    if (point.weight < threshold) {
      continue;
    }

    pointCount += 1;
    weightTotal += point.weight;
    meanX += point.x * point.weight;
    meanY += point.y * point.weight;
  }

  if (pointCount < MIN_EDGE_POINTS || weightTotal <= 0) {
    return 0;
  }

  meanX /= weightTotal;
  meanY /= weightTotal;

  let covXX = 0;
  let covYY = 0;
  let covXY = 0;

  for (const point of magnitudes) {
    if (point.weight < threshold) {
      continue;
    }

    const dx = point.x - meanX;
    const dy = point.y - meanY;
    covXX += point.weight * dx * dx;
    covYY += point.weight * dy * dy;
    covXY += point.weight * dx * dy;
  }

  covXX /= weightTotal;
  covYY /= weightTotal;
  covXY /= weightTotal;

  const trace = covXX + covYY;
  const determinant = covXX * covYY - covXY * covXY;
  const eigenGap = Math.sqrt(Math.max(0, trace * trace - 4 * determinant));
  const lambda1 = (trace + eigenGap) / 2;
  const lambda2 = (trace - eigenGap) / 2;
  const anisotropy = lambda1 > 0 ? (lambda1 - lambda2) / lambda1 : 0;

  if (anisotropy < MIN_ANISOTROPY) {
    return 0;
  }

  return 0.5 * Math.atan2(2 * covXY, covXX - covYY);
};

const buildRotationVariants = (source: HTMLCanvasElement): TicketRotationVariant[] => {
  const variants: TicketRotationVariant[] = [
    { rotationDegrees: 0, canvas: source },
    { rotationDegrees: 90, canvas: rotateCanvas(source, Math.PI / 2) },
    { rotationDegrees: 180, canvas: rotateCanvas(source, Math.PI) },
    { rotationDegrees: 270, canvas: rotateCanvas(source, Math.PI * 1.5) }
  ];

  return variants;
};

export const normalizeTicketOrientationFromVideoFrame = (
  video: HTMLVideoElement,
  localization: TicketLocalizationResult,
  options: TicketNormalizerOptions = {}
): TicketNormalizationResult => {
  if (!frameContext || !cropContext || !localization.found || !localization.box) {
    return {
      success: false,
      canvas: null,
      estimatedAngleDegrees: 0,
      appliedRotationDegrees: 0,
      variants: []
    };
  }

  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return {
      success: false,
      canvas: null,
      estimatedAngleDegrees: 0,
      appliedRotationDegrees: 0,
      variants: []
    };
  }

  frameCanvas.width = sourceWidth;
  frameCanvas.height = sourceHeight;
  frameContext.drawImage(video, 0, 0, sourceWidth, sourceHeight);

  const paddingRatio = clamp(options.paddingRatio ?? DEFAULT_PADDING_RATIO, 0, MAX_PADDING_RATIO);
  const padX = Math.round(localization.box.width * paddingRatio);
  const padY = Math.round(localization.box.height * paddingRatio);

  const cropX = clamp(localization.box.x - padX, 0, sourceWidth - 1);
  const cropY = clamp(localization.box.y - padY, 0, sourceHeight - 1);
  const cropRight = clamp(localization.box.x + localization.box.width + padX, cropX + 1, sourceWidth);
  const cropBottom = clamp(localization.box.y + localization.box.height + padY, cropY + 1, sourceHeight);
  const cropWidth = Math.max(1, cropRight - cropX);
  const cropHeight = Math.max(1, cropBottom - cropY);

  cropCanvas.width = cropWidth;
  cropCanvas.height = cropHeight;
  cropContext.clearRect(0, 0, cropWidth, cropHeight);
  cropContext.drawImage(frameCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  const dominantAngleRadians = computeDominantAxisAngle(cropCanvas);
  let canonicalCanvas = rotateCanvas(cropCanvas, -dominantAngleRadians);
  let appliedRotationDegrees = -radiansToDegrees(dominantAngleRadians);

  if (canonicalCanvas.height > canonicalCanvas.width) {
    canonicalCanvas = rotateCanvas(canonicalCanvas, Math.PI / 2);
    appliedRotationDegrees += 90;
  }

  const variants = options.includeRotationVariants ? buildRotationVariants(canonicalCanvas) : [];

  return {
    success: true,
    canvas: canonicalCanvas,
    estimatedAngleDegrees: radiansToDegrees(dominantAngleRadians),
    appliedRotationDegrees,
    variants
  };
};
