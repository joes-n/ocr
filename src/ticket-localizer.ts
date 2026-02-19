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

type ThresholdProfile = {
  frameLighting: FrameLighting;
  minValue: number;
  minWhiteness: number;
  maxSaturation: number;
  maxSpread: number;
};

type Candidate = {
  box: TicketBoundingBox;
  areaRatio: number;
  fillRatio: number;
  whiteness: number;
  edgeTouchRatio: number;
};

const LOCALIZE_MAX_DIMENSION = 480;
const DEFAULT_MIN_AREA_RATIO = 0.0012;
const DEFAULT_MAX_AREA_RATIO = 0.95;
const MIN_FILL_RATIO = 0.48;
const MIN_ASPECT_RATIO = 1.0;
const MAX_ASPECT_RATIO = 9.5;
const WHITE_BAND = 0.12;

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

const deriveThresholdProfile = (p90Value: number, minWhitenessOverride: number | undefined): ThresholdProfile => {
  if (p90Value < 0.4) {
    return {
      frameLighting: "very-dim",
      minValue: 0.38,
      minWhiteness: minWhitenessOverride ?? 0.3,
      maxSaturation: 0.42,
      maxSpread: 96
    };
  }

  if (p90Value < 0.58) {
    return {
      frameLighting: "dim",
      minValue: 0.48,
      minWhiteness: minWhitenessOverride ?? 0.38,
      maxSaturation: 0.34,
      maxSpread: 88
    };
  }

  return {
    frameLighting: "normal",
    minValue: 0.56,
    minWhiteness: minWhitenessOverride ?? 0.46,
    maxSaturation: 0.28,
    maxSpread: 80
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

const toFrameBox = (box: TicketBoundingBox, scale: number, frameWidth: number, frameHeight: number): TicketBoundingBox => {
  const x = clamp(Math.round(box.x / scale), 0, frameWidth - 1);
  const y = clamp(Math.round(box.y / scale), 0, frameHeight - 1);
  const width = Math.max(1, Math.round(box.width / scale));
  const height = Math.max(1, Math.round(box.height / scale));
  const right = clamp(x + width, x + 1, frameWidth);
  const bottom = clamp(y + height, y + 1, frameHeight);

  return { x, y, width: right - x, height: bottom - y };
};

const failureResult = (
  reasons: string[],
  frameLighting: FrameLighting,
  debug: boolean
): TicketLocalizationResult => ({
  found: false,
  ticketFound: false,
  labelFound: false,
  confidence: 0,
  box: null,
  ticketBox: null,
  labelBox: null,
  debug: debug
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
  const debug = options.debug === true;
  const reasons: string[] = [];

  if (!workContext || frameWidth <= 0 || frameHeight <= 0) {
    reasons.push("frame-unavailable");
    return failureResult(reasons, "normal", debug);
  }

  const scale = Math.min(1, LOCALIZE_MAX_DIMENSION / Math.max(frameWidth, frameHeight));
  const width = Math.max(1, Math.round(frameWidth * scale));
  const height = Math.max(1, Math.round(frameHeight * scale));
  const area = width * height;

  workCanvas.width = width;
  workCanvas.height = height;
  workContext.drawImage(sourceVideo, 0, 0, width, height);

  const pixels = workContext.getImageData(0, 0, width, height).data;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < area; i += 1) {
    const offset = i * 4;
    const maxCh = Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    histogram[maxCh] += 1;
  }

  const p90Value = percentileFromHistogram(histogram, area, 0.9);
  const profile = deriveThresholdProfile(p90Value, options.minWhiteness);
  const minAreaRatio = options.minAreaRatio ?? DEFAULT_MIN_AREA_RATIO;
  const maxAreaRatio = options.maxAreaRatio ?? DEFAULT_MAX_AREA_RATIO;

  const whitenessMap = new Float32Array(area);
  const mask = new Uint8Array(area);

  for (let i = 0; i < area; i += 1) {
    const offset = i * 4;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const maxCh = Math.max(red, green, blue);
    const minCh = Math.min(red, green, blue);
    const spread = maxCh - minCh;
    const value = maxCh / 255;
    const saturation = maxCh === 0 ? 0 : spread / maxCh;
    const whiteness = value * (1 - saturation) * ((255 - spread) / 255);

    whitenessMap[i] = whiteness;

    if (
      value >= profile.minValue &&
      saturation <= profile.maxSaturation &&
      spread <= profile.maxSpread &&
      whiteness >= profile.minWhiteness
    ) {
      mask[i] = 1;
    }
  }

  const cleaned = open3x3(close3x3(mask, width, height), width, height);
  const visited = new Uint8Array(area);
  const candidates: Candidate[] = [];

  for (let start = 0; start < area; start += 1) {
    if (cleaned[start] === 0 || visited[start] === 1) {
      continue;
    }

    const stack: number[] = [start];
    visited[start] = 1;

    let minX = width - 1;
    let minY = height - 1;
    let maxX = 0;
    let maxY = 0;
    let pixelsCount = 0;
    let whiteSum = 0;

    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const x = idx % width;
      const y = (idx - x) / width;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixelsCount += 1;
      whiteSum += whitenessMap[idx];

      const left = x > 0 ? idx - 1 : -1;
      const right = x + 1 < width ? idx + 1 : -1;
      const up = y > 0 ? idx - width : -1;
      const down = y + 1 < height ? idx + width : -1;

      if (left >= 0 && cleaned[left] === 1 && visited[left] === 0) {
        visited[left] = 1;
        stack.push(left);
      }
      if (right >= 0 && cleaned[right] === 1 && visited[right] === 0) {
        visited[right] = 1;
        stack.push(right);
      }
      if (up >= 0 && cleaned[up] === 1 && visited[up] === 0) {
        visited[up] = 1;
        stack.push(up);
      }
      if (down >= 0 && cleaned[down] === 1 && visited[down] === 0) {
        visited[down] = 1;
        stack.push(down);
      }
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const boxArea = boxWidth * boxHeight;
    if (boxArea <= 0 || pixelsCount <= 0) {
      continue;
    }

    const areaRatio = boxArea / area;
    const fillRatio = pixelsCount / boxArea;
    const aspect = Math.max(boxWidth / Math.max(1, boxHeight), boxHeight / Math.max(1, boxWidth));
    const edgeTouches =
      (minX <= 1 ? 1 : 0) + (minY <= 1 ? 1 : 0) + (maxX >= width - 2 ? 1 : 0) + (maxY >= height - 2 ? 1 : 0);
    const edgeTouchRatio = edgeTouches / 4;

    if (areaRatio < minAreaRatio || areaRatio > maxAreaRatio) {
      continue;
    }
    if (fillRatio < MIN_FILL_RATIO) {
      continue;
    }
    if (aspect < MIN_ASPECT_RATIO || aspect > MAX_ASPECT_RATIO) {
      continue;
    }

    candidates.push({
      box: { x: minX, y: minY, width: boxWidth, height: boxHeight },
      areaRatio,
      fillRatio,
      whiteness: whiteSum / pixelsCount,
      edgeTouchRatio
    });
  }

  if (candidates.length === 0) {
    reasons.push("no-white-rectangle");
    return failureResult(reasons, profile.frameLighting, debug);
  }

  const bestWhite = candidates.reduce((max, c) => Math.max(max, c.whiteness), 0);
  const nearWhite = candidates.filter((c) => c.whiteness >= bestWhite - WHITE_BAND);
  const pool = nearWhite.length > 0 ? nearWhite : candidates;

  pool.sort((a, b) => {
    if (a.edgeTouchRatio !== b.edgeTouchRatio) {
      return a.edgeTouchRatio - b.edgeTouchRatio;
    }
    if (a.areaRatio !== b.areaRatio) {
      return a.areaRatio - b.areaRatio;
    }
    if (a.whiteness !== b.whiteness) {
      return b.whiteness - a.whiteness;
    }
    return b.fillRatio - a.fillRatio;
  });

  const selected = pool[0];
  const areaSpan = Math.max(0.0001, maxAreaRatio - minAreaRatio);
  const normalizedArea = clamp((selected.areaRatio - minAreaRatio) / areaSpan, 0, 1);
  const confidence = clamp(
    0.48 * selected.whiteness +
      0.28 * selected.fillRatio +
      0.16 * (1 - normalizedArea) +
      0.08 * (1 - selected.edgeTouchRatio),
    0,
    1
  );
  const box = toFrameBox(selected.box, scale, frameWidth, frameHeight);

  return {
    found: true,
    ticketFound: true,
    labelFound: true,
    confidence,
    box,
    ticketBox: box,
    labelBox: box,
    debug: debug
      ? {
          stage: "white-rectangle",
          reasons,
          ticketScore: confidence,
          labelScore: selected.whiteness,
          frameLighting: profile.frameLighting,
          candidateCount: pool.length,
          selectedAreaRatio: selected.areaRatio,
          selectedWhiteness: selected.whiteness,
          selectedFillRatio: selected.fillRatio
        }
      : undefined
  };
};
