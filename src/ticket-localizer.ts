export type TicketBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TicketLocalizationResult = {
  found: boolean;
  confidence: number;
  // Kept for backward compatibility. Equivalent to ticketBox.
  box: TicketBoundingBox | null;
  ticketBox: TicketBoundingBox | null;
  labelBox: TicketBoundingBox | null;
  debug?: TicketLocalizationDebug;
};

type ConnectedComponent = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
  pixels: number[];
};

type PixelBuffers = {
  hue: Float32Array;
  saturation: Float32Array;
  value: Float32Array;
  luminance: Uint8Array;
};

type StageMasks = {
  blueCoreMask: Uint8Array;
  blueMask: Uint8Array;
  labelMask: Uint8Array;
  skinMask: Uint8Array;
  edgeMask: Uint8Array;
  edgeOnlyMask: Uint8Array;
  blueNeighborhoodMask: Uint8Array;
};

type TicketCandidate = {
  component: ConnectedComponent;
  score: number;
  blueRatio: number;
  skinRatio: number;
  edgeRatio: number;
  aspect: number;
};

type LabelCandidate = {
  component: ConnectedComponent;
  score: number;
  adjacencyRatio: number;
  fillRatio: number;
  meanSaturation: number;
  meanValue: number;
};

type EdgeCandidate = {
  component: ConnectedComponent;
  score: number;
  skinRatio: number;
  edgeRatio: number;
};

export type TicketLocalizationDebug = {
  stage: "blue-then-label" | "label-fallback" | "edge-fallback";
  reasons: string[];
  ticketScore: number;
  labelScore: number;
  edgeScore: number;
  blueRatio: number;
  labelRatio: number;
  skinRatio: number;
  edgeRatio: number;
  fallbackUsed: boolean;
  confidenceBeforeCaps: number;
  confidenceAfterCaps: number;
};

export type TicketLocalizerOptions = {
  debug?: boolean;
  minBlueSupportRatio?: number;
};

const LOCALIZE_MAX_DIMENSION = 360;

const MIN_TICKET_AREA_RATIO = 0.03;
const MIN_EDGE_AREA_RATIO = 0.03;
const MIN_LABEL_AREA_RATIO = 0.0015;

const TICKET_TARGET_ASPECT = 2.5;
const TICKET_ASPECT_MIN = 1.8;
const TICKET_ASPECT_MAX = 3.4;

const BLUE_HUE_CORE_MIN = 186;
const BLUE_HUE_CORE_MAX = 244;
const BLUE_HUE_SUPPORT_MIN = 170;
const BLUE_HUE_SUPPORT_MAX = 258;
const BLUE_SAT_CORE_MIN = 0.2;
const BLUE_SAT_SUPPORT_MIN = 0.12;
const BLUE_VALUE_MIN = 0.12;

const LABEL_SATURATION_MAX = 0.26;
const LABEL_VALUE_MIN = 0.68;

const SKIN_HUE_A_MIN = 0;
const SKIN_HUE_A_MAX = 35;
const SKIN_HUE_B_MIN = 340;
const SKIN_HUE_B_MAX = 360;
const SKIN_SAT_MIN = 0.16;
const SKIN_SAT_MAX = 0.78;
const SKIN_VALUE_MIN = 0.2;
const SKIN_VALUE_MAX = 0.98;
const SKIN_HEAVY_RATIO_THRESHOLD = 0.3;

const EDGE_THRESHOLD_SCALE = 0.65;

const BLUE_LABEL_COMBINED_PASS_THRESHOLD = 0.48;
const MIN_TICKET_SCORE_PASS = 0.22;
const MIN_LABEL_SCORE_PASS = 0.26;
const LABEL_FALLBACK_MIN_SCORE = 0.68;
const LABEL_FALLBACK_PASS_THRESHOLD = 0.5;
const EDGE_FALLBACK_PASS_THRESHOLD = 0.55;

const MIN_BLUE_SUPPORT_RATIO = 0.04;

const FALLBACK_TICKET_WIDTH_MULTIPLIER = 1.95;
const FALLBACK_TICKET_HEIGHT_MULTIPLIER = 2.55;
const FALLBACK_TICKET_X_CENTER_OFFSET = 0.48;
const FALLBACK_TICKET_Y_CENTER_OFFSET = 0.58;

const workCanvas = document.createElement("canvas");
const workContext = workCanvas.getContext("2d", { willReadFrequently: true });

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const hueInRange = (hue: number, min: number, max: number): boolean =>
  min <= max ? hue >= min && hue <= max : hue >= min || hue <= max;

const rgbToHsv = (
  red: number,
  green: number,
  blue: number
): {
  hue: number;
  saturation: number;
  value: number;
} => {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === r) {
      hue = ((g - b) / delta) % 6;
    } else if (max === g) {
      hue = (b - r) / delta + 2;
    } else {
      hue = (r - g) / delta + 4;
    }

    hue *= 60;
    if (hue < 0) {
      hue += 360;
    }
  }

  const saturation = max === 0 ? 0 : delta / max;
  return { hue, saturation, value: max };
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

const open3x3 = (source: Uint8Array, width: number, height: number): Uint8Array =>
  dilate3x3(erode3x3(source, width, height), width, height);

const close3x3 = (source: Uint8Array, width: number, height: number): Uint8Array =>
  erode3x3(dilate3x3(source, width, height), width, height);

const componentToBox = (component: ConnectedComponent): TicketBoundingBox => ({
  x: component.minX,
  y: component.minY,
  width: component.maxX - component.minX + 1,
  height: component.maxY - component.minY + 1
});

const scaleBox = (box: TicketBoundingBox, scale: number): TicketBoundingBox => ({
  x: Math.round(box.x * scale),
  y: Math.round(box.y * scale),
  width: Math.max(1, Math.round(box.width * scale)),
  height: Math.max(1, Math.round(box.height * scale))
});

const clampBoxToBounds = (box: TicketBoundingBox, width: number, height: number): TicketBoundingBox => {
  const left = clamp(box.x, 0, width - 1);
  const top = clamp(box.y, 0, height - 1);
  const right = clamp(box.x + box.width, left + 1, width);
  const bottom = clamp(box.y + box.height, top + 1, height);

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
};

const computeEdgeMask = (luminance: Uint8Array, width: number, height: number): Uint8Array => {
  const edgeMagnitude = new Float32Array(width * height);
  let sum = 0;
  let sumSq = 0;
  let sampleCount = 0;

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

      const index = y * width + x;
      edgeMagnitude[index] = magnitude;
      sum += magnitude;
      sumSq += magnitude * magnitude;
      sampleCount += 1;
    }
  }

  if (sampleCount === 0) {
    return new Uint8Array(width * height);
  }

  const mean = sum / sampleCount;
  const stdDev = Math.sqrt(Math.max(0, sumSq / sampleCount - mean * mean));
  const threshold = mean + stdDev * EDGE_THRESHOLD_SCALE;

  const edgeMask = new Uint8Array(width * height);
  for (let index = 0; index < edgeMask.length; index += 1) {
    edgeMask[index] = edgeMagnitude[index] >= threshold ? 1 : 0;
  }

  return edgeMask;
};

const buildPixelBuffers = (pixels: Uint8ClampedArray, width: number, height: number): PixelBuffers => {
  const length = width * height;
  const hue = new Float32Array(length);
  const saturation = new Float32Array(length);
  const value = new Float32Array(length);
  const luminance = new Uint8Array(length);

  for (let index = 0; index < length; index += 1) {
    const pixelOffset = index * 4;
    const red = pixels[pixelOffset];
    const green = pixels[pixelOffset + 1];
    const blue = pixels[pixelOffset + 2];

    const hsv = rgbToHsv(red, green, blue);
    hue[index] = hsv.hue;
    saturation[index] = hsv.saturation;
    value[index] = hsv.value;
    luminance[index] = Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
  }

  return { hue, saturation, value, luminance };
};

const buildMasks = (buffers: PixelBuffers, width: number, height: number): StageMasks => {
  const length = width * height;
  const blueCoreMask = new Uint8Array(length);
  const blueSupportMask = new Uint8Array(length);
  const labelMaskRaw = new Uint8Array(length);
  const skinMask = new Uint8Array(length);

  for (let index = 0; index < length; index += 1) {
    const hue = buffers.hue[index];
    const saturation = buffers.saturation[index];
    const value = buffers.value[index];

    const isBlueCore =
      hueInRange(hue, BLUE_HUE_CORE_MIN, BLUE_HUE_CORE_MAX) &&
      saturation >= BLUE_SAT_CORE_MIN &&
      value >= BLUE_VALUE_MIN;
    blueCoreMask[index] = isBlueCore ? 1 : 0;

    const isBlueSupport =
      hueInRange(hue, BLUE_HUE_SUPPORT_MIN, BLUE_HUE_SUPPORT_MAX) &&
      saturation >= BLUE_SAT_SUPPORT_MIN &&
      value >= BLUE_VALUE_MIN;
    blueSupportMask[index] = isBlueSupport ? 1 : 0;

    const isLabelLike = saturation <= LABEL_SATURATION_MAX && value >= LABEL_VALUE_MIN;
    labelMaskRaw[index] = isLabelLike ? 1 : 0;

    const isSkinLike =
      (hueInRange(hue, SKIN_HUE_A_MIN, SKIN_HUE_A_MAX) || hueInRange(hue, SKIN_HUE_B_MIN, SKIN_HUE_B_MAX)) &&
      saturation >= SKIN_SAT_MIN &&
      saturation <= SKIN_SAT_MAX &&
      value >= SKIN_VALUE_MIN &&
      value <= SKIN_VALUE_MAX;
    skinMask[index] = isSkinLike ? 1 : 0;
  }

  const blueMaskRaw = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    blueMaskRaw[index] = blueCoreMask[index] === 1 || blueSupportMask[index] === 1 ? 1 : 0;
  }

  const blueMask = close3x3(open3x3(blueMaskRaw, width, height), width, height);
  const labelMask = close3x3(open3x3(labelMaskRaw, width, height), width, height);
  const edgeMask = computeEdgeMask(buffers.luminance, width, height);
  const edgeOnlyMask = close3x3(edgeMask, width, height);
  const blueNeighborhoodMask = dilate3x3(dilate3x3(blueMask, width, height), width, height);

  return {
    blueCoreMask,
    blueMask,
    labelMask,
    skinMask,
    edgeMask,
    edgeOnlyMask,
    blueNeighborhoodMask
  };
};

const findComponents = (mask: Uint8Array, width: number, height: number, minAreaRatio: number): ConnectedComponent[] => {
  const visited = new Uint8Array(mask.length);
  const queueX = new Int32Array(mask.length);
  const queueY = new Int32Array(mask.length);
  const minArea = Math.max(1, Math.round(width * height * minAreaRatio));
  const components: ConnectedComponent[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startIndex = y * width + x;
      if (mask[startIndex] === 0 || visited[startIndex] === 1) {
        continue;
      }

      let head = 0;
      let tail = 0;
      queueX[tail] = x;
      queueY[tail] = y;
      tail += 1;
      visited[startIndex] = 1;

      const pixels: number[] = [];
      let area = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;

      while (head < tail) {
        const currentX = queueX[head];
        const currentY = queueY[head];
        head += 1;

        const index = currentY * width + currentX;
        pixels.push(index);
        area += 1;

        if (currentX < minX) minX = currentX;
        if (currentY < minY) minY = currentY;
        if (currentX > maxX) maxX = currentX;
        if (currentY > maxY) maxY = currentY;

        const neighbors = [
          [currentX + 1, currentY],
          [currentX - 1, currentY],
          [currentX, currentY + 1],
          [currentX, currentY - 1]
        ];

        for (const [nextX, nextY] of neighbors) {
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
            continue;
          }

          const nextIndex = nextY * width + nextX;
          if (visited[nextIndex] === 1 || mask[nextIndex] === 0) {
            continue;
          }

          visited[nextIndex] = 1;
          queueX[tail] = nextX;
          queueY[tail] = nextY;
          tail += 1;
        }
      }

      if (area < minArea) {
        continue;
      }

      components.push({
        minX,
        minY,
        maxX,
        maxY,
        area,
        pixels
      });
    }
  }

  return components;
};

const getAspect = (component: ConnectedComponent): number => {
  const width = component.maxX - component.minX + 1;
  const height = component.maxY - component.minY + 1;
  if (width <= 0 || height <= 0) {
    return 0;
  }
  return width >= height ? width / height : height / width;
};

const scoreTicketCandidate = (
  component: ConnectedComponent,
  masks: StageMasks,
  width: number,
  height: number
): TicketCandidate => {
  const imageArea = width * height;
  const boxWidth = component.maxX - component.minX + 1;
  const boxHeight = component.maxY - component.minY + 1;
  const boxArea = boxWidth * boxHeight;
  const aspect = getAspect(component);

  let blueHits = 0;
  let skinHits = 0;
  let edgeHits = 0;

  for (const index of component.pixels) {
    if (masks.blueMask[index] === 1) {
      blueHits += 1;
    }
    if (masks.skinMask[index] === 1) {
      skinHits += 1;
    }
    if (masks.edgeMask[index] === 1) {
      edgeHits += 1;
    }
  }

  const areaRatio = component.area / imageArea;
  const fillRatio = component.area / Math.max(1, boxArea);
  const blueRatio = blueHits / Math.max(1, component.area);
  const skinRatio = skinHits / Math.max(1, component.area);
  const edgeRatio = edgeHits / Math.max(1, component.area);

  const areaScore = clamp((areaRatio - MIN_TICKET_AREA_RATIO) / 0.30, 0, 1);
  const fillScore = clamp((fillRatio - 0.25) / 0.60, 0, 1);
  const aspectScore = clamp(1 - Math.abs(aspect - TICKET_TARGET_ASPECT) / 1.45, 0, 1);

  let score =
    areaScore * 0.2 +
    aspectScore * 0.25 +
    fillScore * 0.15 +
    clamp(blueRatio / 0.38, 0, 1) * 0.3 +
    clamp(edgeRatio / 0.45, 0, 1) * 0.1;

  if (aspect < TICKET_ASPECT_MIN || aspect > TICKET_ASPECT_MAX) {
    score *= 0.6;
  }

  if (skinRatio > 0.2) {
    score -= Math.min(0.4, (skinRatio - 0.2) * 1.4);
  }

  score = clamp(score, 0, 1);

  return {
    component,
    score,
    blueRatio,
    skinRatio,
    edgeRatio,
    aspect
  };
};

const scoreLabelCandidate = (
  component: ConnectedComponent,
  masks: StageMasks,
  buffers: PixelBuffers,
  width: number,
  height: number,
  ticketCandidate: TicketCandidate | null
): LabelCandidate => {
  const boxWidth = component.maxX - component.minX + 1;
  const boxHeight = component.maxY - component.minY + 1;
  const boxArea = boxWidth * boxHeight;

  let adjacencyHits = 0;
  let saturationSum = 0;
  let valueSum = 0;

  for (const index of component.pixels) {
    if (masks.blueNeighborhoodMask[index] === 1) {
      adjacencyHits += 1;
    }
    saturationSum += buffers.saturation[index];
    valueSum += buffers.value[index];
  }

  const area = Math.max(1, component.area);
  const adjacencyRatio = adjacencyHits / area;
  const fillRatio = component.area / Math.max(1, boxArea);
  const meanSaturation = saturationSum / area;
  const meanValue = valueSum / area;

  let sizeScore = 0;
  if (ticketCandidate) {
    const labelAreaRatioToTicket = component.area / Math.max(1, ticketCandidate.component.area);
    if (labelAreaRatioToTicket >= 0.03 && labelAreaRatioToTicket <= 0.45) {
      sizeScore = 1;
    } else {
      const distance =
        labelAreaRatioToTicket < 0.03
          ? Math.abs(labelAreaRatioToTicket - 0.03)
          : Math.abs(labelAreaRatioToTicket - 0.45);
      sizeScore = clamp(1 - distance / 0.22, 0, 1);
    }
  } else {
    const areaRatio = component.area / Math.max(1, width * height);
    sizeScore = clamp(1 - Math.abs(areaRatio - 0.025) / 0.05, 0, 1);
  }

  const brightnessScore = clamp((meanValue - LABEL_VALUE_MIN) / (1 - LABEL_VALUE_MIN), 0, 1);
  const saturationScore = clamp((LABEL_SATURATION_MAX - meanSaturation) / LABEL_SATURATION_MAX, 0, 1);
  const rectangularityScore = clamp((fillRatio - 0.45) / 0.45, 0, 1);
  const adjacencyScore = clamp((adjacencyRatio - 0.1) / 0.7, 0, 1);

  let score =
    brightnessScore * 0.3 +
    saturationScore * 0.2 +
    rectangularityScore * 0.25 +
    adjacencyScore * 0.25;

  score *= 0.55 + sizeScore * 0.45;

  if (ticketCandidate && adjacencyRatio < 0.15) {
    score *= 0.6;
  }

  score = clamp(score, 0, 1);

  return {
    component,
    score,
    adjacencyRatio,
    fillRatio,
    meanSaturation,
    meanValue
  };
};

const scoreEdgeCandidate = (
  component: ConnectedComponent,
  masks: StageMasks,
  width: number,
  height: number
): EdgeCandidate => {
  const imageArea = width * height;
  const boxWidth = component.maxX - component.minX + 1;
  const boxHeight = component.maxY - component.minY + 1;
  const boxArea = boxWidth * boxHeight;

  let edgeHits = 0;
  let skinHits = 0;
  for (const index of component.pixels) {
    if (masks.edgeMask[index] === 1) {
      edgeHits += 1;
    }
    if (masks.skinMask[index] === 1) {
      skinHits += 1;
    }
  }

  const areaRatio = component.area / imageArea;
  const fillRatio = component.area / Math.max(1, boxArea);
  const aspect = getAspect(component);
  const edgeRatio = edgeHits / Math.max(1, component.area);
  const skinRatio = skinHits / Math.max(1, component.area);

  const areaScore = clamp((areaRatio - MIN_EDGE_AREA_RATIO) / 0.32, 0, 1);
  const aspectScore = clamp(1 - Math.abs(aspect - TICKET_TARGET_ASPECT) / 1.8, 0, 1);
  const fillScore = clamp((fillRatio - 0.12) / 0.55, 0, 1);

  let score =
    areaScore * 0.25 +
    aspectScore * 0.35 +
    fillScore * 0.2 +
    clamp(edgeRatio / 0.55, 0, 1) * 0.2;

  if (skinRatio > 0.2) {
    score -= Math.min(0.35, (skinRatio - 0.2) * 1.2);
  }

  score = clamp(score, 0, 1);

  return {
    component,
    score,
    skinRatio,
    edgeRatio
  };
};

const pickBestTicketCandidate = (masks: StageMasks, width: number, height: number): TicketCandidate | null => {
  const components = findComponents(masks.blueMask, width, height, MIN_TICKET_AREA_RATIO);
  let best: TicketCandidate | null = null;

  for (const component of components) {
    const candidate = scoreTicketCandidate(component, masks, width, height);
    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  return best;
};

const pickBestLabelCandidate = (
  masks: StageMasks,
  buffers: PixelBuffers,
  width: number,
  height: number,
  ticketCandidate: TicketCandidate | null
): LabelCandidate | null => {
  const length = width * height;
  let searchMask: Uint8Array | null = null;

  if (ticketCandidate) {
    const ticketBox = componentToBox(ticketCandidate.component);
    const marginX = Math.max(4, Math.round(ticketBox.width * 0.08));
    const marginY = Math.max(4, Math.round(ticketBox.height * 0.08));
    const minX = clamp(ticketBox.x - marginX, 0, width - 1);
    const minY = clamp(ticketBox.y - marginY, 0, height - 1);
    const maxX = clamp(ticketBox.x + ticketBox.width + marginX, minX + 1, width);
    const maxY = clamp(ticketBox.y + ticketBox.height + marginY, minY + 1, height);

    searchMask = new Uint8Array(length);
    for (let y = minY; y < maxY; y += 1) {
      for (let x = minX; x < maxX; x += 1) {
        searchMask[y * width + x] = 1;
      }
    }
  }

  const filteredLabelMask = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const inSearchDomain = searchMask ? searchMask[index] === 1 : true;
    filteredLabelMask[index] = masks.labelMask[index] === 1 && inSearchDomain ? 1 : 0;
  }

  const labelCandidates = findComponents(filteredLabelMask, width, height, MIN_LABEL_AREA_RATIO);
  let best: LabelCandidate | null = null;

  for (const component of labelCandidates) {
    const scored = scoreLabelCandidate(component, masks, buffers, width, height, ticketCandidate);
    if (!best || scored.score > best.score) {
      best = scored;
    }
  }

  return best;
};

const pickBestEdgeCandidate = (masks: StageMasks, width: number, height: number): EdgeCandidate | null => {
  const components = findComponents(masks.edgeOnlyMask, width, height, MIN_EDGE_AREA_RATIO);
  let best: EdgeCandidate | null = null;

  for (const component of components) {
    const candidate = scoreEdgeCandidate(component, masks, width, height);
    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  return best;
};

const inferTicketFromLabel = (labelBox: TicketBoundingBox, width: number, height: number): TicketBoundingBox => {
  const labelCenterX = labelBox.x + labelBox.width * 0.5;
  const labelCenterY = labelBox.y + labelBox.height * 0.5;

  const ticketWidth = Math.max(1, Math.round(labelBox.width * FALLBACK_TICKET_WIDTH_MULTIPLIER));
  const ticketHeight = Math.max(1, Math.round(labelBox.height * FALLBACK_TICKET_HEIGHT_MULTIPLIER));

  const inferred: TicketBoundingBox = {
    x: Math.round(labelCenterX - ticketWidth * FALLBACK_TICKET_X_CENTER_OFFSET),
    y: Math.round(labelCenterY - ticketHeight * FALLBACK_TICKET_Y_CENTER_OFFSET),
    width: ticketWidth,
    height: ticketHeight
  };

  return clampBoxToBounds(inferred, width, height);
};

export const localizeTicketFromVideoFrame = (
  video: HTMLVideoElement,
  options: TicketLocalizerOptions = {}
): TicketLocalizationResult => {
  if (!workContext) {
    return {
      found: false,
      confidence: 0,
      box: null,
      ticketBox: null,
      labelBox: null,
      debug: options.debug
        ? {
            stage: "blue-then-label",
            reasons: ["NO_WORK_CONTEXT"],
            ticketScore: 0,
            labelScore: 0,
            edgeScore: 0,
            blueRatio: 0,
            labelRatio: 0,
            skinRatio: 0,
            edgeRatio: 0,
            fallbackUsed: false,
            confidenceBeforeCaps: 0,
            confidenceAfterCaps: 0
          }
        : undefined
    };
  }

  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return {
      found: false,
      confidence: 0,
      box: null,
      ticketBox: null,
      labelBox: null,
      debug: options.debug
        ? {
            stage: "blue-then-label",
            reasons: ["VIDEO_DIMENSIONS_UNAVAILABLE"],
            ticketScore: 0,
            labelScore: 0,
            edgeScore: 0,
            blueRatio: 0,
            labelRatio: 0,
            skinRatio: 0,
            edgeRatio: 0,
            fallbackUsed: false,
            confidenceBeforeCaps: 0,
            confidenceAfterCaps: 0
          }
        : undefined
    };
  }

  const scale = Math.min(1, LOCALIZE_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

  workCanvas.width = targetWidth;
  workCanvas.height = targetHeight;
  workContext.drawImage(video, 0, 0, targetWidth, targetHeight);

  const frame = workContext.getImageData(0, 0, targetWidth, targetHeight);
  const buffers = buildPixelBuffers(frame.data, targetWidth, targetHeight);
  const masks = buildMasks(buffers, targetWidth, targetHeight);

  const ticketCandidate = pickBestTicketCandidate(masks, targetWidth, targetHeight);
  const labelCandidate = pickBestLabelCandidate(masks, buffers, targetWidth, targetHeight, ticketCandidate);

  const minBlueSupportRatio = options.minBlueSupportRatio ?? MIN_BLUE_SUPPORT_RATIO;

  let stage: TicketLocalizationDebug["stage"] = "blue-then-label";
  const reasons: string[] = [];
  let fallbackUsed = false;

  let ticketBoxScaled: TicketBoundingBox | null = ticketCandidate ? componentToBox(ticketCandidate.component) : null;
  let labelBoxScaled: TicketBoundingBox | null = labelCandidate ? componentToBox(labelCandidate.component) : null;

  let ticketScore = ticketCandidate?.score ?? 0;
  const labelScore = labelCandidate?.score ?? 0;
  let edgeScore = 0;
  let blueRatio = ticketCandidate?.blueRatio ?? 0;
  let skinRatio = ticketCandidate?.skinRatio ?? 0;
  let edgeRatio = ticketCandidate?.edgeRatio ?? 0;
  const labelRatio =
    ticketCandidate && labelCandidate
      ? labelCandidate.component.area / Math.max(1, ticketCandidate.component.area)
      : 0;

  let confidenceBeforeCaps = 0;
  let confidence = 0;

  if (!ticketCandidate) {
    reasons.push("NO_BLUE_TICKET_CANDIDATE");
  }
  if (!labelCandidate) {
    reasons.push("NO_WHITE_LABEL_CANDIDATE");
  }

  if (ticketCandidate && labelCandidate) {
    confidenceBeforeCaps = clamp(ticketScore * 0.6 + labelScore * 0.4, 0, 1);
    confidence = confidenceBeforeCaps;

    if (blueRatio < minBlueSupportRatio) {
      const blueFactor = clamp(blueRatio / Math.max(minBlueSupportRatio, 0.01), 0, 1);
      confidence = Math.min(confidence, 0.52 * blueFactor + 0.05);
      reasons.push("LOW_BLUE_RATIO");
    }

    if (skinRatio > SKIN_HEAVY_RATIO_THRESHOLD) {
      const skinFactor = clamp(1 - (skinRatio - SKIN_HEAVY_RATIO_THRESHOLD) * 1.6, 0.15, 1);
      confidence *= skinFactor;
      reasons.push("SKIN_OCCLUSION_HEAVY");
    }

    if (ticketCandidate.aspect < TICKET_ASPECT_MIN || ticketCandidate.aspect > TICKET_ASPECT_MAX) {
      confidence *= 0.7;
      reasons.push("TICKET_ASPECT_OUT_OF_RANGE");
    }

    confidence = clamp(confidence, 0, 1);
  }

  let found =
    ticketBoxScaled !== null &&
    labelBoxScaled !== null &&
    confidence >= BLUE_LABEL_COMBINED_PASS_THRESHOLD &&
    ticketScore >= MIN_TICKET_SCORE_PASS &&
    labelScore >= MIN_LABEL_SCORE_PASS;

  if (ticketCandidate && ticketScore < MIN_TICKET_SCORE_PASS) {
    reasons.push("LOW_TICKET_SCORE");
  }
  if (labelCandidate && labelScore < MIN_LABEL_SCORE_PASS) {
    reasons.push("LOW_LABEL_SCORE");
  }
  if (ticketCandidate && labelCandidate && confidence < BLUE_LABEL_COMBINED_PASS_THRESHOLD) {
    reasons.push("LOW_COMBINED_CONFIDENCE");
  }

  if (!found && labelCandidate && labelScore >= LABEL_FALLBACK_MIN_SCORE) {
    stage = "label-fallback";
    fallbackUsed = true;
    labelBoxScaled = componentToBox(labelCandidate.component);
    ticketBoxScaled = inferTicketFromLabel(labelBoxScaled, targetWidth, targetHeight);

    confidenceBeforeCaps = clamp(0.5 + labelScore * 0.2 + labelCandidate.adjacencyRatio * 0.2, 0, 1);
    confidence = clamp(Math.min(0.62, confidenceBeforeCaps), 0, 1);
    found = confidence >= LABEL_FALLBACK_PASS_THRESHOLD;
    if (!found) {
      reasons.push("LABEL_FALLBACK_CONFIDENCE_LOW");
    }

    ticketScore = Math.max(ticketScore, 0.25);
    blueRatio = ticketCandidate?.blueRatio ?? 0;
    skinRatio = ticketCandidate?.skinRatio ?? 0;
    edgeRatio = ticketCandidate?.edgeRatio ?? 0;
  } else if (!found && labelCandidate && labelScore < LABEL_FALLBACK_MIN_SCORE) {
    reasons.push("LABEL_FALLBACK_SCORE_LOW");
  }

  if (!found) {
    const edgeCandidate = pickBestEdgeCandidate(masks, targetWidth, targetHeight);
    if (edgeCandidate && labelCandidate && labelScore >= MIN_LABEL_SCORE_PASS) {
      stage = "edge-fallback";
      fallbackUsed = true;
      ticketBoxScaled = componentToBox(edgeCandidate.component);
      labelBoxScaled = componentToBox(labelCandidate.component);
      edgeScore = edgeCandidate.score;
      skinRatio = edgeCandidate.skinRatio;
      edgeRatio = edgeCandidate.edgeRatio;

      confidenceBeforeCaps = clamp(edgeScore * 0.55 + labelScore * 0.45, 0, 1);
      confidence = clamp(confidenceBeforeCaps * 0.78, 0, 1);
      found = confidence >= EDGE_FALLBACK_PASS_THRESHOLD;
      if (!found) {
        reasons.push("EDGE_FALLBACK_CONFIDENCE_LOW");
      }
    } else if (!edgeCandidate) {
      reasons.push("NO_EDGE_FALLBACK_CANDIDATE");
    }
  }

  if (!found || !ticketBoxScaled) {
    return {
      found: false,
      confidence: 0,
      box: null,
      ticketBox: null,
      labelBox: null,
      debug: options.debug
        ? {
            stage,
            reasons,
            ticketScore,
            labelScore,
            edgeScore,
            blueRatio,
            labelRatio,
            skinRatio,
            edgeRatio,
            fallbackUsed,
            confidenceBeforeCaps,
            confidenceAfterCaps: confidence
          }
        : undefined
    };
  }

  const inverseScale = 1 / scale;
  const ticketBox = scaleBox(ticketBoxScaled, inverseScale);
  const labelBox = labelBoxScaled ? scaleBox(labelBoxScaled, inverseScale) : null;

  return {
    found: true,
    confidence,
    box: ticketBox,
    ticketBox,
    labelBox,
    debug: options.debug
      ? {
          stage,
          reasons,
          ticketScore,
          labelScore,
          edgeScore,
          blueRatio,
          labelRatio,
          skinRatio,
          edgeRatio,
          fallbackUsed,
          confidenceBeforeCaps,
          confidenceAfterCaps: confidence
        }
      : undefined
  };
};
