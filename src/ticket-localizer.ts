export type TicketBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TicketLocalizationResult = {
  found: boolean;
  confidence: number;
  box: TicketBoundingBox | null;
};

type ComponentStats = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
  colorHits: number;
  edgeHits: number;
};

type ComponentCandidate = {
  component: ComponentStats;
  score: number;
};

type MaskSet = {
  colorMask: Uint8Array;
  edgeMask: Uint8Array;
  fusedMask: Uint8Array;
  edgeOnlyMask: Uint8Array;
};

const LOCALIZE_MAX_DIMENSION = 360;

const TARGET_TICKET_ASPECT = 2.5;
const MIN_COMPONENT_AREA_RATIO = 0.06;
const SATURATION_MIN_FLOOR = 0.1;
const SATURATION_MAX_CEILING = 0.34;
const WHITE_SATURATION_MAX = 0.12;
const WHITE_VALUE_MIN = 0.72;
const BLUE_HUE_MIN = 180;
const BLUE_HUE_MAX = 250;
const EDGE_THRESHOLD_SCALE = 0.65;
const FALLBACK_CONFIDENCE_FLOOR = 0.35;

const workCanvas = document.createElement("canvas");
const workContext = workCanvas.getContext("2d", { willReadFrequently: true });

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

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

const buildMasks = (pixels: Uint8ClampedArray, width: number, height: number): MaskSet => {
  const length = width * height;
  const hueBuffer = new Float32Array(length);
  const saturationBuffer = new Float32Array(length);
  const valueBuffer = new Float32Array(length);
  const luminanceBuffer = new Uint8Array(length);

  let saturationSum = 0;
  let saturationSumSq = 0;
  let valueSum = 0;

  for (let index = 0; index < length; index += 1) {
    const pixelOffset = index * 4;
    const red = pixels[pixelOffset];
    const green = pixels[pixelOffset + 1];
    const blue = pixels[pixelOffset + 2];

    const { hue, saturation, value } = rgbToHsv(red, green, blue);
    hueBuffer[index] = hue;
    saturationBuffer[index] = saturation;
    valueBuffer[index] = value;
    luminanceBuffer[index] = Math.round(0.299 * red + 0.587 * green + 0.114 * blue);

    saturationSum += saturation;
    saturationSumSq += saturation * saturation;
    valueSum += value;
  }

  const saturationMean = saturationSum / length;
  const saturationStdDev = Math.sqrt(Math.max(0, saturationSumSq / length - saturationMean * saturationMean));
  const valueMean = valueSum / length;

  const saturationThreshold = clamp(
    saturationMean + saturationStdDev * 0.3,
    SATURATION_MIN_FLOOR,
    SATURATION_MAX_CEILING
  );
  const valueThreshold = clamp(valueMean - 0.25, 0.12, 0.45);

  const colorMask = new Uint8Array(length);
  const blueBoostMask = new Uint8Array(length);
  const whiteLikeMask = new Uint8Array(length);

  for (let index = 0; index < length; index += 1) {
    const hue = hueBuffer[index];
    const saturation = saturationBuffer[index];
    const value = valueBuffer[index];

    const isWhiteLike = saturation <= WHITE_SATURATION_MAX && value >= WHITE_VALUE_MIN;
    whiteLikeMask[index] = isWhiteLike ? 1 : 0;

    const isColorCandidate = saturation >= saturationThreshold && value >= valueThreshold;
    colorMask[index] = isColorCandidate && !isWhiteLike ? 1 : 0;

    const isBlueBoost = hue >= BLUE_HUE_MIN && hue <= BLUE_HUE_MAX && saturation >= 0.2 && value >= 0.15;
    blueBoostMask[index] = isBlueBoost ? 1 : 0;
  }

  const edgeMaskRaw = computeEdgeMask(luminanceBuffer, width, height);

  const colorUnionMask = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    colorUnionMask[index] = colorMask[index] === 1 || blueBoostMask[index] === 1 ? 1 : 0;
  }

  const colorNeighborhoodMask = dilate3x3(colorUnionMask, width, height);
  const edgeSupportedMask = new Uint8Array(length);

  for (let index = 0; index < length; index += 1) {
    const keepEdge = edgeMaskRaw[index] === 1 && colorNeighborhoodMask[index] === 1 && whiteLikeMask[index] === 0;
    edgeSupportedMask[index] = keepEdge ? 1 : 0;
  }

  const fusedRawMask = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    fusedRawMask[index] = colorUnionMask[index] === 1 || edgeSupportedMask[index] === 1 ? 1 : 0;
  }

  const fusedMask = close3x3(open3x3(fusedRawMask, width, height), width, height);
  const edgeOnlyMask = close3x3(edgeMaskRaw, width, height);

  return {
    colorMask: colorUnionMask,
    edgeMask: edgeMaskRaw,
    fusedMask,
    edgeOnlyMask
  };
};

const componentScore = (component: ComponentStats, imageArea: number): number => {
  const width = component.maxX - component.minX + 1;
  const height = component.maxY - component.minY + 1;
  const boxArea = width * height;

  if (boxArea <= 0 || component.area <= 0) {
    return 0;
  }

  const areaRatio = boxArea / imageArea;
  const fillRatio = component.area / boxArea;
  const aspect = width > height ? width / height : height / width;
  const aspectScore = 1 - Math.min(1, Math.abs(aspect - TARGET_TICKET_ASPECT) / 1.6);
  const colorSupport = component.colorHits / component.area;
  const edgeSupport = component.edgeHits / component.area;

  const weighted =
    areaRatio * 1.3 +
    fillRatio * 0.7 +
    aspectScore * 0.9 +
    colorSupport * 0.9 +
    edgeSupport * 0.5;

  return clamp(weighted / 4.3, 0, 1);
};

const findBestComponent = (
  mask: Uint8Array,
  colorMask: Uint8Array,
  edgeMask: Uint8Array,
  width: number,
  height: number,
  minAreaRatio: number
): ComponentCandidate | null => {
  const visited = new Uint8Array(mask.length);
  const queueX = new Int32Array(mask.length);
  const queueY = new Int32Array(mask.length);
  const minArea = Math.round(width * height * minAreaRatio);

  let bestCandidate: ComponentCandidate | null = null;

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

      let area = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      let colorHits = 0;
      let edgeHits = 0;

      while (head < tail) {
        const currentX = queueX[head];
        const currentY = queueY[head];
        head += 1;

        const index = currentY * width + currentX;
        area += 1;

        if (colorMask[index] === 1) {
          colorHits += 1;
        }

        if (edgeMask[index] === 1) {
          edgeHits += 1;
        }

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

      const component: ComponentStats = {
        minX,
        minY,
        maxX,
        maxY,
        area,
        colorHits,
        edgeHits
      };
      const score = componentScore(component, width * height);

      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = { component, score };
      }
    }
  }

  return bestCandidate;
};

export const localizeTicketFromVideoFrame = (video: HTMLVideoElement): TicketLocalizationResult => {
  if (!workContext) {
    return { found: false, confidence: 0, box: null };
  }

  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { found: false, confidence: 0, box: null };
  }

  const scale = Math.min(1, LOCALIZE_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

  workCanvas.width = targetWidth;
  workCanvas.height = targetHeight;
  workContext.drawImage(video, 0, 0, targetWidth, targetHeight);

  const frame = workContext.getImageData(0, 0, targetWidth, targetHeight);
  const masks = buildMasks(frame.data, targetWidth, targetHeight);

  const hybridCandidate = findBestComponent(
    masks.fusedMask,
    masks.colorMask,
    masks.edgeMask,
    targetWidth,
    targetHeight,
    MIN_COMPONENT_AREA_RATIO
  );

  let chosenCandidate = hybridCandidate;

  if (!chosenCandidate || chosenCandidate.score < FALLBACK_CONFIDENCE_FLOOR) {
    const edgeCandidate = findBestComponent(
      masks.edgeOnlyMask,
      masks.colorMask,
      masks.edgeMask,
      targetWidth,
      targetHeight,
      MIN_COMPONENT_AREA_RATIO
    );

    if (edgeCandidate && (!chosenCandidate || edgeCandidate.score * 0.9 > chosenCandidate.score)) {
      chosenCandidate = {
        component: edgeCandidate.component,
        score: edgeCandidate.score * 0.9
      };
    }
  }

  if (!chosenCandidate) {
    return { found: false, confidence: 0, box: null };
  }

  const componentWidth = chosenCandidate.component.maxX - chosenCandidate.component.minX + 1;
  const componentHeight = chosenCandidate.component.maxY - chosenCandidate.component.minY + 1;
  const confidence = clamp(chosenCandidate.score, 0, 1);

  const inverseScale = 1 / scale;
  return {
    found: true,
    confidence,
    box: {
      x: Math.round(chosenCandidate.component.minX * inverseScale),
      y: Math.round(chosenCandidate.component.minY * inverseScale),
      width: Math.round(componentWidth * inverseScale),
      height: Math.round(componentHeight * inverseScale)
    }
  };
};
