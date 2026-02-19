export type TicketBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type FrameLighting = "normal" | "dim" | "very-dim";

export type TicketLocalizationDebug = {
  stage: "white-rectangle";
  reasons: string[];
  ticketScore: number;
  labelScore: number;
  frameLighting: FrameLighting;
  candidateCount: number;
  selectedAreaRatio: number;
  selectedWhiteness: number;
  selectedFillRatio: number;
};

export type TicketLocalizationResult = {
  found: boolean;
  ticketFound: boolean;
  labelFound: boolean;
  confidence: number;
  box: TicketBoundingBox | null;
  ticketBox: TicketBoundingBox | null;
  labelBox: TicketBoundingBox | null;
  debug?: TicketLocalizationDebug;
};

export type TicketLocalizerOptions = {
  debug?: boolean;
  minWhiteness?: number;
  minAreaRatio?: number;
  maxAreaRatio?: number;
};

type ComponentCandidate = {
  box: TicketBoundingBox;
  bboxArea: number;
  areaRatio: number;
  fillRatio: number;
  whiteness: number;
};

type ThresholdProfile = {
  frameLighting: FrameLighting;
  minValue: number;
  minWhiteness: number;
  maxSaturation: number;
  maxSpread: number;
};

const LOCALIZE_MAX_DIMENSION = 480;
const DEFAULT_MIN_AREA_RATIO = 0.003;
const DEFAULT_MAX_AREA_RATIO = 0.35;
const MIN_FILL_RATIO = 0.58;
const MIN_ASPECT_RATIO = 1.1;
const MAX_ASPECT_RATIO = 8;
const WHITE_BAND = 0.08;

const workCanvas = document.createElement("canvas");
const workContext = workCanvas.getContext("2d", { willReadFrequently: true });

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const percentileFromHistogram = (histogram: Uint32Array, total: number, percentile: number): number => {
  if (total <= 0) {
    return 0;
  }

  const target = Math.max(0, Math.min(total - 1, Math.floor(total * percentile)));
  let cumulative = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    cumulative += histogram[value];
    if (cumulative > target) {
      return value / 255;
    }
  }

  return 1;
};

const deriveThresholdProfile = (
  p90Value: number,
  optionMinWhiteness: number | undefined
): ThresholdProfile => {
  if (p90Value < 0.42) {
    return {
      frameLighting: "very-dim",
      minValue: 0.45,
      minWhiteness: optionMinWhiteness ?? 0.4,
      maxSaturation: 0.34,
      maxSpread: 85
    };
  }

  if (p90Value < 0.58) {
    return {
      frameLighting: "dim",
      minValue: 0.55,
      minWhiteness: optionMinWhiteness ?? 0.5,
      maxSaturation: 0.28,
      maxSpread: 75
    };
  }

  return {
    frameLighting: "normal",
    minValue: 0.64,
    minWhiteness: optionMinWhiteness ?? 0.58,
    maxSaturation: 0.22,
    maxSpread: 65
  };
};

const dilate3x3 = (source: Uint8Array, width: number, height: number): Uint8Array => {
  const output = new Uint8Array(source.length);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let hit = 0;
      for (let oy = -1; oy <= 1 && hit === 0; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (source[(y + oy) * width + (x + ox)] === 1) {
            hit = 1;
            break;
          }
        }
      }
      output[y * width + x] = hit;
    }
  }

  return output;
};

const erode3x3 = (source: Uint8Array, width: number, height: number): Uint8Array => {
  const output = new Uint8Array(source.length);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let keep = 1;
      for (let oy = -1; oy <= 1 && keep === 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (source[(y + oy) * width + (x + ox)] === 0) {
            keep = 0;
            break;
          }
        }
      }
      output[y * width + x] = keep;
    }
  }

  return output;
};

const close3x3 = (source: Uint8Array, width: number, height: number): Uint8Array =>
  erode3x3(dilate3x3(source, width, height), width, height);

const open3x3 = (source: Uint8Array, width: number, height: number): Uint8Array =>
  dilate3x3(erode3x3(source, width, height), width, height);

const toScaledBox = (
  box: TicketBoundingBox,
  scale: number,
  frameWidth: number,
  frameHeight: number
): TicketBoundingBox => {
  const x = clamp(Math.round(box.x / scale), 0, frameWidth - 1);
  const y = clamp(Math.round(box.y / scale), 0, frameHeight - 1);
  const width = Math.max(1, Math.round(box.width / scale));
  const height = Math.max(1, Math.round(box.height / scale));
  const right = clamp(x + width, x + 1, frameWidth);
  const bottom = clamp(y + height, y + 1, frameHeight);

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
};

const buildFailureResult = (
  reasons: string[],
  frameLighting: FrameLighting,
  debugEnabled: boolean
): TicketLocalizationResult => ({
  found: false,
  ticketFound: false,
  labelFound: false,
  confidence: 0,
  box: null,
  ticketBox: null,
  labelBox: null,
  debug: debugEnabled
    ? {
        stage: "white-rectangle",
        reasons,
        ticketScore: 0,
        labelScore: 0,
        frameLighting,
        candidateCount: 0,
        selectedAreaRatio: 0,
        selectedWhiteness: 0,
        selectedFillRatio: 0
      }
    : undefined
});

export const localizeTicketFromVideoFrame = (
  sourceVideo: HTMLVideoElement,
  options: TicketLocalizerOptions = {}
): TicketLocalizationResult => {
  const frameWidth = sourceVideo.videoWidth;
  const frameHeight = sourceVideo.videoHeight;
  const reasons: string[] = [];
  const debugEnabled = options.debug === true;

  if (!workContext || frameWidth <= 0 || frameHeight <= 0) {
    reasons.push("frame-unavailable");
    return buildFailureResult(reasons, "normal", debugEnabled);
  }

  const scale = Math.min(1, LOCALIZE_MAX_DIMENSION / Math.max(frameWidth, frameHeight));
  const sampleWidth = Math.max(1, Math.round(frameWidth * scale));
  const sampleHeight = Math.max(1, Math.round(frameHeight * scale));
  const frameArea = sampleWidth * sampleHeight;

  workCanvas.width = sampleWidth;
  workCanvas.height = sampleHeight;
  workContext.drawImage(sourceVideo, 0, 0, sampleWidth, sampleHeight);

  const imageData = workContext.getImageData(0, 0, sampleWidth, sampleHeight);
  const pixels = imageData.data;

  const valueHistogram = new Uint32Array(256);
  for (let index = 0; index < frameArea; index += 1) {
    const offset = index * 4;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const maxChannel = Math.max(red, green, blue);
    valueHistogram[maxChannel] += 1;
  }

  const p90Value = percentileFromHistogram(valueHistogram, frameArea, 0.9);
  const profile = deriveThresholdProfile(p90Value, options.minWhiteness);
  const minAreaRatio = options.minAreaRatio ?? DEFAULT_MIN_AREA_RATIO;
  const maxAreaRatio = options.maxAreaRatio ?? DEFAULT_MAX_AREA_RATIO;

  const whiteness = new Float32Array(frameArea);
  const whiteMask = new Uint8Array(frameArea);

  for (let index = 0; index < frameArea; index += 1) {
    const offset = index * 4;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];

    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const spread = maxChannel - minChannel;
    const value = maxChannel / 255;
    const saturation = maxChannel === 0 ? 0 : spread / maxChannel;

    const whitenessScore = value * (1 - saturation) * ((255 - spread) / 255);
    whiteness[index] = whitenessScore;

    if (
      value >= profile.minValue &&
      saturation <= profile.maxSaturation &&
      spread <= profile.maxSpread &&
      whitenessScore >= profile.minWhiteness
    ) {
      whiteMask[index] = 1;
    }
  }

  const cleanedMask = open3x3(close3x3(whiteMask, sampleWidth, sampleHeight), sampleWidth, sampleHeight);
  const visited = new Uint8Array(frameArea);
  const candidates: ComponentCandidate[] = [];

  for (let start = 0; start < frameArea; start += 1) {
    if (cleanedMask[start] === 0 || visited[start] === 1) {
      continue;
    }

    const stack: number[] = [start];
    visited[start] = 1;

    let minX = sampleWidth - 1;
    let minY = sampleHeight - 1;
    let maxX = 0;
    let maxY = 0;
    let pixelCount = 0;
    let whitenessSum = 0;

    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % sampleWidth;
      const y = (index - x) / sampleWidth;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixelCount += 1;
      whitenessSum += whiteness[index];

      const left = x > 0 ? index - 1 : -1;
      const right = x + 1 < sampleWidth ? index + 1 : -1;
      const up = y > 0 ? index - sampleWidth : -1;
      const down = y + 1 < sampleHeight ? index + sampleWidth : -1;

      if (left >= 0 && cleanedMask[left] === 1 && visited[left] === 0) {
        visited[left] = 1;
        stack.push(left);
      }
      if (right >= 0 && cleanedMask[right] === 1 && visited[right] === 0) {
        visited[right] = 1;
        stack.push(right);
      }
      if (up >= 0 && cleanedMask[up] === 1 && visited[up] === 0) {
        visited[up] = 1;
        stack.push(up);
      }
      if (down >= 0 && cleanedMask[down] === 1 && visited[down] === 0) {
        visited[down] = 1;
        stack.push(down);
      }
    }

    if (pixelCount <= 0) {
      continue;
    }

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const bboxArea = width * height;
    const areaRatio = bboxArea / frameArea;
    const fillRatio = pixelCount / Math.max(1, bboxArea);
    const aspectRatio = Math.max(width / Math.max(1, height), height / Math.max(1, width));
    const touchesFrameEdge =
      minX <= 1 || minY <= 1 || maxX >= sampleWidth - 2 || maxY >= sampleHeight - 2;

    if (touchesFrameEdge) {
      continue;
    }
    if (areaRatio < minAreaRatio || areaRatio > maxAreaRatio) {
      continue;
    }
    if (fillRatio < MIN_FILL_RATIO) {
      continue;
    }
    if (aspectRatio < MIN_ASPECT_RATIO || aspectRatio > MAX_ASPECT_RATIO) {
      continue;
    }

    candidates.push({
      box: {
        x: minX,
        y: minY,
        width,
        height
      },
      bboxArea,
      areaRatio,
      fillRatio,
      whiteness: whitenessSum / pixelCount
    });
  }

  if (candidates.length === 0) {
    reasons.push("no-white-rectangle");
    return buildFailureResult(reasons, profile.frameLighting, debugEnabled);
  }

  const bestWhiteness = candidates.reduce((max, candidate) => Math.max(max, candidate.whiteness), 0);
  const nearWhiteCandidates = candidates.filter((candidate) => candidate.whiteness >= bestWhiteness - WHITE_BAND);

  nearWhiteCandidates.sort((a, b) => {
    if (a.bboxArea !== b.bboxArea) {
      return a.bboxArea - b.bboxArea;
    }

    if (a.whiteness !== b.whiteness) {
      return b.whiteness - a.whiteness;
    }

    return b.fillRatio - a.fillRatio;
  });

  const selected = nearWhiteCandidates[0];
  const selectedBox = toScaledBox(selected.box, scale, frameWidth, frameHeight);
  const areaSpan = Math.max(0.0001, maxAreaRatio - minAreaRatio);
  const areaPosition = clamp((selected.areaRatio - minAreaRatio) / areaSpan, 0, 1);
  const smallAreaScore = 1 - areaPosition;
  const confidence = clamp(0.55 * selected.whiteness + 0.3 * selected.fillRatio + 0.15 * smallAreaScore, 0, 1);

  return {
    found: true,
    ticketFound: true,
    labelFound: true,
    confidence,
    box: selectedBox,
    ticketBox: selectedBox,
    labelBox: selectedBox,
    debug: debugEnabled
      ? {
          stage: "white-rectangle",
          reasons,
          ticketScore: confidence,
          labelScore: selected.whiteness,
          frameLighting: profile.frameLighting,
          candidateCount: nearWhiteCandidates.length,
          selectedAreaRatio: selected.areaRatio,
          selectedWhiteness: selected.whiteness,
          selectedFillRatio: selected.fillRatio
        }
      : undefined
  };
};
