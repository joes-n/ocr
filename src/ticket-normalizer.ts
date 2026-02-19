import type { TicketLocalizationResult } from "./ticket-localizer";

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

export type TicketNormalizationMethod = "perspective" | "rotation-fallback";

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

type ComponentCandidate = {
  pixels: number[];
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centroidX: number;
  centroidY: number;
  score: number;
};

const MAX_PADDING_RATIO = 0.25;
const DEFAULT_PADDING_RATIO = 0.04;
const MIN_EDGE_POINTS = 180;
const MIN_ANISOTROPY = 0.08;
const QUAD_ESTIMATION_MAX_DIMENSION = 480;
const CANONICAL_TICKET_WIDTH = 1250;
const CANONICAL_TICKET_HEIGHT = 500;
const MIN_COMPONENT_AREA_RATIO = 0.18;
const TARGET_TICKET_ASPECT = 2.5;
const MIN_TICKET_ASPECT = 2.1;
const MAX_TICKET_ASPECT = 2.9;
const MIN_SIDE_RATIO = 0.08;
const MIN_WARP_CONFIDENCE = 0.45;

const frameCanvas = document.createElement("canvas");
const frameContext = frameCanvas.getContext("2d", { willReadFrequently: true });
const cropCanvas = document.createElement("canvas");
const cropContext = cropCanvas.getContext("2d", { willReadFrequently: true });
const quadWorkCanvas = document.createElement("canvas");
const quadWorkContext = quadWorkCanvas.getContext("2d", { willReadFrequently: true });

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

const buildRotationVariants = (source: HTMLCanvasElement): TicketRotationVariant[] => [
  { rotationDegrees: 0, canvas: source },
  { rotationDegrees: 90, canvas: rotateCanvas(source, Math.PI / 2) },
  { rotationDegrees: 180, canvas: rotateCanvas(source, Math.PI) },
  { rotationDegrees: 270, canvas: rotateCanvas(source, Math.PI * 1.5) }
];

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
  if (delta > 0) {
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

const close3x3 = (source: Uint8Array, width: number, height: number): Uint8Array =>
  erode3x3(dilate3x3(source, width, height), width, height);

const open3x3 = (source: Uint8Array, width: number, height: number): Uint8Array =>
  dilate3x3(erode3x3(source, width, height), width, height);

const buildTicketMask = (pixels: Uint8ClampedArray, width: number, height: number): Uint8Array => {
  const output = new Uint8Array(width * height);

  for (let index = 0; index < output.length; index += 1) {
    const offset = index * 4;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];

    const { hue, saturation, value } = rgbToHsv(red, green, blue);
    const isBlueTicket = hue >= 165 && hue <= 255 && saturation >= 0.08 && value >= 0.12;
    const isLightPaper = saturation <= 0.33 && value >= 0.4;
    const isSkinLike =
      ((hue >= 0 && hue <= 35) || hue >= 335) &&
      saturation >= 0.16 &&
      saturation <= 0.8 &&
      value >= 0.18 &&
      value <= 0.98;
    const isDark = value <= 0.08;

    output[index] = !isDark && !isSkinLike && (isBlueTicket || isLightPaper) ? 1 : 0;
  }

  return close3x3(open3x3(output, width, height), width, height);
};

const pickBestMaskComponent = (mask: Uint8Array, width: number, height: number): ComponentCandidate | null => {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const minArea = Math.max(1, Math.round(width * height * MIN_COMPONENT_AREA_RATIO));
  const centerX = (width - 1) * 0.5;
  const centerY = (height - 1) * 0.5;
  const maxCenterDistance = Math.hypot(centerX, centerY);
  let best: ComponentCandidate | null = null;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (mask[start] === 0 || visited[start] === 1) {
        continue;
      }

      let head = 0;
      let tail = 0;
      queue[tail] = start;
      tail += 1;
      visited[start] = 1;

      const pixels: number[] = [];
      let area = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      let sumX = 0;
      let sumY = 0;

      while (head < tail) {
        const index = queue[head];
        head += 1;
        pixels.push(index);
        area += 1;

        const currentX = index % width;
        const currentY = (index - currentX) / width;
        sumX += currentX;
        sumY += currentY;

        if (currentX < minX) minX = currentX;
        if (currentY < minY) minY = currentY;
        if (currentX > maxX) maxX = currentX;
        if (currentY > maxY) maxY = currentY;

        const neighbors = [index + 1, index - 1, index + width, index - width];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || neighbor >= mask.length || visited[neighbor] === 1 || mask[neighbor] === 0) {
            continue;
          }

          const neighborX = neighbor % width;
          const neighborY = (neighbor - neighborX) / width;
          if (Math.abs(neighborX - currentX) + Math.abs(neighborY - currentY) !== 1) {
            continue;
          }

          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }

      if (area < minArea) {
        continue;
      }

      const centroidX = sumX / area;
      const centroidY = sumY / area;
      const areaRatio = area / (width * height);
      const centerDistance = Math.hypot(centroidX - centerX, centroidY - centerY);
      const centerScore = 1 - clamp(centerDistance / Math.max(1, maxCenterDistance), 0, 1);
      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      const aspect = boxWidth > boxHeight ? boxWidth / Math.max(1, boxHeight) : boxHeight / Math.max(1, boxWidth);
      const aspectScore = 1 - Math.min(1, Math.abs(aspect - TARGET_TICKET_ASPECT) / 2.0);
      const score = areaRatio * 1.4 + centerScore * 0.8 + aspectScore * 0.8;

      if (!best || score > best.score) {
        best = {
          pixels,
          area,
          minX,
          minY,
          maxX,
          maxY,
          centroidX,
          centroidY,
          score
        };
      }
    }
  }

  return best;
};

const quadToPoints = (quad: TicketQuad): Point2D[] => [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];

const orderQuadPoints = (points: Point2D[]): TicketQuad | null => {
  if (points.length !== 4) {
    return null;
  }

  const sums = points.map((point) => point.x + point.y);
  const diffs = points.map((point) => point.y - point.x);
  const topLeftIndex = sums.indexOf(Math.min(...sums));
  const bottomRightIndex = sums.indexOf(Math.max(...sums));
  const topRightIndex = diffs.indexOf(Math.min(...diffs));
  const bottomLeftIndex = diffs.indexOf(Math.max(...diffs));

  const unique = new Set([topLeftIndex, topRightIndex, bottomRightIndex, bottomLeftIndex]);
  if (unique.size !== 4) {
    return null;
  }

  return {
    topLeft: points[topLeftIndex],
    topRight: points[topRightIndex],
    bottomRight: points[bottomRightIndex],
    bottomLeft: points[bottomLeftIndex]
  };
};

const isConvexQuad = (quad: TicketQuad): boolean => {
  const points = quadToPoints(quad);
  let expectedSign = 0;

  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const sign = Math.sign(cross);
    if (sign === 0) {
      return false;
    }
    if (expectedSign === 0) {
      expectedSign = sign;
    } else if (sign !== expectedSign) {
      return false;
    }
  }

  return true;
};

const distance = (a: Point2D, b: Point2D): number => Math.hypot(a.x - b.x, a.y - b.y);

const polygonArea = (points: Point2D[]): number => {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    sum += current.x * next.y - current.y * next.x;
  }
  return Math.abs(sum) * 0.5;
};

const validateQuad = (
  quad: TicketQuad,
  componentArea: number,
  width: number,
  height: number
): { valid: boolean; confidence: number; aspect: number } => {
  if (!isConvexQuad(quad)) {
    return { valid: false, confidence: 0, aspect: 0 };
  }

  const top = distance(quad.topLeft, quad.topRight);
  const bottom = distance(quad.bottomLeft, quad.bottomRight);
  const left = distance(quad.topLeft, quad.bottomLeft);
  const right = distance(quad.topRight, quad.bottomRight);
  const minSide = Math.min(top, bottom, left, right);
  const averageWidth = (top + bottom) * 0.5;
  const averageHeight = (left + right) * 0.5;
  const aspect = averageHeight > 0 ? averageWidth / averageHeight : 0;

  if (minSide < Math.max(width, height) * MIN_SIDE_RATIO) {
    return { valid: false, confidence: 0, aspect };
  }

  if (aspect < MIN_TICKET_ASPECT || aspect > MAX_TICKET_ASPECT) {
    return { valid: false, confidence: 0, aspect };
  }

  const quadArea = polygonArea(quadToPoints(quad));
  const imageArea = width * height;
  const areaRatio = componentArea / imageArea;
  const quadAreaRatio = quadArea / imageArea;
  if (areaRatio < MIN_COMPONENT_AREA_RATIO || quadAreaRatio < MIN_COMPONENT_AREA_RATIO) {
    return { valid: false, confidence: 0, aspect };
  }

  const areaScore = clamp((quadAreaRatio - MIN_COMPONENT_AREA_RATIO) / 0.62, 0, 1);
  const aspectScore = 1 - Math.min(1, Math.abs(aspect - TARGET_TICKET_ASPECT) / 0.6);
  const fillRatio = componentArea / Math.max(1, quadArea);
  const fillScore = clamp(fillRatio / 0.95, 0, 1);
  const confidence = clamp(areaScore * 0.45 + aspectScore * 0.35 + fillScore * 0.2, 0, 1);

  return { valid: true, confidence, aspect };
};

const estimateQuadFromMaskComponent = (component: ComponentCandidate, width: number, height: number): TicketQuad | null => {
  if (component.pixels.length < 64) {
    return null;
  }

  let covXX = 0;
  let covYY = 0;
  let covXY = 0;
  for (const index of component.pixels) {
    const x = index % width;
    const y = (index - x) / width;
    const dx = x - component.centroidX;
    const dy = y - component.centroidY;
    covXX += dx * dx;
    covYY += dy * dy;
    covXY += dx * dy;
  }

  covXX /= component.pixels.length;
  covYY /= component.pixels.length;
  covXY /= component.pixels.length;

  const axisAngle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  const axisU: Point2D = { x: Math.cos(axisAngle), y: Math.sin(axisAngle) };
  const axisV: Point2D = { x: -Math.sin(axisAngle), y: Math.cos(axisAngle) };

  let minU = Number.POSITIVE_INFINITY;
  let maxU = Number.NEGATIVE_INFINITY;
  let minV = Number.POSITIVE_INFINITY;
  let maxV = Number.NEGATIVE_INFINITY;

  for (const index of component.pixels) {
    const x = index % width;
    const y = (index - x) / width;
    const projectionU = x * axisU.x + y * axisU.y;
    const projectionV = x * axisV.x + y * axisV.y;
    if (projectionU < minU) minU = projectionU;
    if (projectionU > maxU) maxU = projectionU;
    if (projectionV < minV) minV = projectionV;
    if (projectionV > maxV) maxV = projectionV;
  }

  const cornerCandidates: Point2D[] = [
    { x: axisU.x * minU + axisV.x * minV, y: axisU.y * minU + axisV.y * minV },
    { x: axisU.x * maxU + axisV.x * minV, y: axisU.y * maxU + axisV.y * minV },
    { x: axisU.x * maxU + axisV.x * maxV, y: axisU.y * maxU + axisV.y * maxV },
    { x: axisU.x * minU + axisV.x * maxV, y: axisU.y * minU + axisV.y * maxV }
  ];

  return orderQuadPoints(cornerCandidates);
};

const scaleQuad = (quad: TicketQuad, scaleX: number, scaleY: number): TicketQuad => ({
  topLeft: { x: quad.topLeft.x * scaleX, y: quad.topLeft.y * scaleY },
  topRight: { x: quad.topRight.x * scaleX, y: quad.topRight.y * scaleY },
  bottomRight: { x: quad.bottomRight.x * scaleX, y: quad.bottomRight.y * scaleY },
  bottomLeft: { x: quad.bottomLeft.x * scaleX, y: quad.bottomLeft.y * scaleY }
});

const solveLinearSystem = (matrix: number[][]): number[] | null => {
  const rowCount = matrix.length;
  const columnCount = matrix[0]?.length ?? 0;
  if (rowCount === 0 || columnCount !== rowCount + 1) {
    return null;
  }

  for (let pivot = 0; pivot < rowCount; pivot += 1) {
    let bestRow = pivot;
    let bestMagnitude = Math.abs(matrix[pivot][pivot]);
    for (let row = pivot + 1; row < rowCount; row += 1) {
      const magnitude = Math.abs(matrix[row][pivot]);
      if (magnitude > bestMagnitude) {
        bestMagnitude = magnitude;
        bestRow = row;
      }
    }

    if (bestMagnitude < 1e-8) {
      return null;
    }

    if (bestRow !== pivot) {
      const temp = matrix[pivot];
      matrix[pivot] = matrix[bestRow];
      matrix[bestRow] = temp;
    }

    const pivotValue = matrix[pivot][pivot];
    for (let column = pivot; column < columnCount; column += 1) {
      matrix[pivot][column] /= pivotValue;
    }

    for (let row = 0; row < rowCount; row += 1) {
      if (row === pivot) {
        continue;
      }

      const factor = matrix[row][pivot];
      if (factor === 0) {
        continue;
      }

      for (let column = pivot; column < columnCount; column += 1) {
        matrix[row][column] -= factor * matrix[pivot][column];
      }
    }
  }

  const solution = new Array<number>(rowCount);
  for (let row = 0; row < rowCount; row += 1) {
    solution[row] = matrix[row][columnCount - 1];
  }

  return solution;
};

const solveHomography = (from: Point2D[], to: Point2D[]): number[] | null => {
  if (from.length !== 4 || to.length !== 4) {
    return null;
  }

  const system: number[][] = [];
  for (let i = 0; i < 4; i += 1) {
    const src = from[i];
    const dst = to[i];
    system.push([src.x, src.y, 1, 0, 0, 0, -dst.x * src.x, -dst.x * src.y, dst.x]);
    system.push([0, 0, 0, src.x, src.y, 1, -dst.y * src.x, -dst.y * src.y, dst.y]);
  }

  const solution = solveLinearSystem(system);
  if (!solution) {
    return null;
  }

  return [solution[0], solution[1], solution[2], solution[3], solution[4], solution[5], solution[6], solution[7], 1];
};

const warpPerspective = (
  source: HTMLCanvasElement,
  sourceQuad: TicketQuad,
  outputWidth: number,
  outputHeight: number
): HTMLCanvasElement | null => {
  const sourceContext = source.getContext("2d", { willReadFrequently: true });
  if (!sourceContext) {
    return null;
  }

  const sourceImage = sourceContext.getImageData(0, 0, source.width, source.height);
  const sourcePixels = sourceImage.data;

  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = outputWidth;
  outputCanvas.height = outputHeight;
  const outputContext = outputCanvas.getContext("2d");
  if (!outputContext) {
    return null;
  }

  const destinationCorners: Point2D[] = [
    { x: 0, y: 0 },
    { x: outputWidth - 1, y: 0 },
    { x: outputWidth - 1, y: outputHeight - 1 },
    { x: 0, y: outputHeight - 1 }
  ];

  const sourceCorners = quadToPoints(sourceQuad);
  const homography = solveHomography(destinationCorners, sourceCorners);
  if (!homography) {
    return null;
  }

  const outputImage = outputContext.createImageData(outputWidth, outputHeight);
  const outputPixels = outputImage.data;
  const [h11, h12, h13, h21, h22, h23, h31, h32] = homography;

  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const denominator = h31 * x + h32 * y + 1;
      if (Math.abs(denominator) < 1e-8) {
        continue;
      }

      const sourceX = (h11 * x + h12 * y + h13) / denominator;
      const sourceY = (h21 * x + h22 * y + h23) / denominator;
      const sampleX = Math.round(sourceX);
      const sampleY = Math.round(sourceY);
      if (sampleX < 0 || sampleY < 0 || sampleX >= source.width || sampleY >= source.height) {
        continue;
      }

      const sourceOffset = (sampleY * source.width + sampleX) * 4;
      const targetOffset = (y * outputWidth + x) * 4;
      outputPixels[targetOffset] = sourcePixels[sourceOffset];
      outputPixels[targetOffset + 1] = sourcePixels[sourceOffset + 1];
      outputPixels[targetOffset + 2] = sourcePixels[sourceOffset + 2];
      outputPixels[targetOffset + 3] = 255;
    }
  }

  outputContext.putImageData(outputImage, 0, 0);
  return outputCanvas;
};

const computeEdgeDensity = (
  luminance: Uint8Array,
  width: number,
  height: number,
  xRatioStart: number,
  xRatioEnd: number,
  yRatioStart: number,
  yRatioEnd: number
): number => {
  const startX = clamp(Math.floor(width * xRatioStart), 1, Math.max(1, width - 2));
  const endX = clamp(Math.floor(width * xRatioEnd), startX + 1, width - 1);
  const startY = clamp(Math.floor(height * yRatioStart), 1, Math.max(1, height - 2));
  const endY = clamp(Math.floor(height * yRatioEnd), startY + 1, height - 1);
  let sum = 0;
  let count = 0;

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = y * width + x;
      const dx = Math.abs(luminance[index + 1] - luminance[index - 1]);
      const dy = Math.abs(luminance[index + width] - luminance[index - width]);
      sum += dx + dy;
      count += 1;
    }
  }

  return count > 0 ? sum / count : 0;
};

const scoreCanonicalOrientation = (canvas: HTMLCanvasElement): number => {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || canvas.width < 3 || canvas.height < 3) {
    return 0;
  }

  const frame = context.getImageData(0, 0, canvas.width, canvas.height);
  const luminance = new Uint8Array(canvas.width * canvas.height);
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    const red = frame.data[offset];
    const green = frame.data[offset + 1];
    const blue = frame.data[offset + 2];
    luminance[index] = Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
  }

  const leftEdgeDensity = computeEdgeDensity(luminance, canvas.width, canvas.height, 0.05, 0.47, 0.16, 0.86);
  const rightEdgeDensity = computeEdgeDensity(luminance, canvas.width, canvas.height, 0.53, 0.95, 0.16, 0.86);
  const lowerLeftDensity = computeEdgeDensity(luminance, canvas.width, canvas.height, 0.1, 0.52, 0.58, 0.95);
  const upperLeftDensity = computeEdgeDensity(luminance, canvas.width, canvas.height, 0.1, 0.52, 0.06, 0.42);

  return leftEdgeDensity - rightEdgeDensity + (lowerLeftDensity - upperLeftDensity) * 0.35;
};

const chooseCanonicalOrientation = (warpedCanvas: HTMLCanvasElement): { canvas: HTMLCanvasElement; rotationDegrees: number } => {
  const uprightScore = scoreCanonicalOrientation(warpedCanvas);
  const rotated180 = rotateCanvas(warpedCanvas, Math.PI);
  const flippedScore = scoreCanonicalOrientation(rotated180);
  return flippedScore > uprightScore ? { canvas: rotated180, rotationDegrees: 180 } : { canvas: warpedCanvas, rotationDegrees: 0 };
};

const fallbackNormalize = (
  source: HTMLCanvasElement,
  includeRotationVariants: boolean
): {
  canvas: HTMLCanvasElement;
  estimatedAngleDegrees: number;
  appliedRotationDegrees: number;
  variants: TicketRotationVariant[];
} => {
  const dominantAngleRadians = computeDominantAxisAngle(source);
  let canonicalCanvas = rotateCanvas(source, -dominantAngleRadians);
  let appliedRotationDegrees = -radiansToDegrees(dominantAngleRadians);

  if (canonicalCanvas.height > canonicalCanvas.width) {
    canonicalCanvas = rotateCanvas(canonicalCanvas, Math.PI / 2);
    appliedRotationDegrees += 90;
  }

  return {
    canvas: canonicalCanvas,
    estimatedAngleDegrees: radiansToDegrees(dominantAngleRadians),
    appliedRotationDegrees,
    variants: includeRotationVariants ? buildRotationVariants(canonicalCanvas) : []
  };
};

const estimatePerspectiveQuad = (crop: HTMLCanvasElement): { quad: TicketQuad; confidence: number } | null => {
  if (!quadWorkContext || crop.width <= 0 || crop.height <= 0) {
    return null;
  }

  const scale = Math.min(1, QUAD_ESTIMATION_MAX_DIMENSION / Math.max(crop.width, crop.height));
  const scaledWidth = Math.max(1, Math.round(crop.width * scale));
  const scaledHeight = Math.max(1, Math.round(crop.height * scale));

  quadWorkCanvas.width = scaledWidth;
  quadWorkCanvas.height = scaledHeight;
  quadWorkContext.clearRect(0, 0, scaledWidth, scaledHeight);
  quadWorkContext.drawImage(crop, 0, 0, scaledWidth, scaledHeight);

  const scaledImage = quadWorkContext.getImageData(0, 0, scaledWidth, scaledHeight);
  const mask = buildTicketMask(scaledImage.data, scaledWidth, scaledHeight);
  const component = pickBestMaskComponent(mask, scaledWidth, scaledHeight);
  if (!component) {
    return null;
  }

  const scaledQuad = estimateQuadFromMaskComponent(component, scaledWidth, scaledHeight);
  if (!scaledQuad) {
    return null;
  }

  const validation = validateQuad(scaledQuad, component.area, scaledWidth, scaledHeight);
  if (!validation.valid) {
    return null;
  }

  const scaleX = crop.width / scaledWidth;
  const scaleY = crop.height / scaledHeight;
  return {
    quad: scaleQuad(scaledQuad, scaleX, scaleY),
    confidence: validation.confidence
  };
};

export const normalizeTicketOrientationFromVideoFrame = (
  video: HTMLVideoElement,
  localization: TicketLocalizationResult,
  options: TicketNormalizerOptions = {}
): TicketNormalizationResult => {
  const hasTicket = localization.ticketFound ?? localization.found;
  const ticketBox = localization.ticketBox ?? localization.box;

  if (!frameContext || !cropContext || !hasTicket || !ticketBox) {
    return {
      success: false,
      canvas: null,
      estimatedAngleDegrees: 0,
      appliedRotationDegrees: 0,
      variants: [],
      method: "rotation-fallback",
      quad: null,
      warpConfidence: 0
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
      variants: [],
      method: "rotation-fallback",
      quad: null,
      warpConfidence: 0
    };
  }

  frameCanvas.width = sourceWidth;
  frameCanvas.height = sourceHeight;
  frameContext.drawImage(video, 0, 0, sourceWidth, sourceHeight);

  const paddingRatio = clamp(options.paddingRatio ?? DEFAULT_PADDING_RATIO, 0, MAX_PADDING_RATIO);
  const padX = Math.round(ticketBox.width * paddingRatio);
  const padY = Math.round(ticketBox.height * paddingRatio);
  const cropX = clamp(ticketBox.x - padX, 0, sourceWidth - 1);
  const cropY = clamp(ticketBox.y - padY, 0, sourceHeight - 1);
  const cropRight = clamp(ticketBox.x + ticketBox.width + padX, cropX + 1, sourceWidth);
  const cropBottom = clamp(ticketBox.y + ticketBox.height + padY, cropY + 1, sourceHeight);
  const cropWidth = Math.max(1, cropRight - cropX);
  const cropHeight = Math.max(1, cropBottom - cropY);

  cropCanvas.width = cropWidth;
  cropCanvas.height = cropHeight;
  cropContext.clearRect(0, 0, cropWidth, cropHeight);
  cropContext.drawImage(frameCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  const includeRotationVariants = options.includeRotationVariants ?? false;
  const perspective = estimatePerspectiveQuad(cropCanvas);
  if (perspective && perspective.confidence >= MIN_WARP_CONFIDENCE) {
    const warped = warpPerspective(cropCanvas, perspective.quad, CANONICAL_TICKET_WIDTH, CANONICAL_TICKET_HEIGHT);
    if (warped) {
      const chosenOrientation = chooseCanonicalOrientation(warped);
      const topEdgeAngle = Math.atan2(
        perspective.quad.topRight.y - perspective.quad.topLeft.y,
        perspective.quad.topRight.x - perspective.quad.topLeft.x
      );
      const estimatedAngleDegrees = radiansToDegrees(topEdgeAngle);
      const variants = includeRotationVariants ? buildRotationVariants(chosenOrientation.canvas) : [];

      return {
        success: true,
        canvas: chosenOrientation.canvas,
        estimatedAngleDegrees,
        appliedRotationDegrees: chosenOrientation.rotationDegrees,
        variants,
        method: "perspective",
        quad: perspective.quad,
        warpConfidence: perspective.confidence
      };
    }
  }

  const fallback = fallbackNormalize(cropCanvas, includeRotationVariants);
  return {
    success: true,
    canvas: fallback.canvas,
    estimatedAngleDegrees: fallback.estimatedAngleDegrees,
    appliedRotationDegrees: fallback.appliedRotationDegrees,
    variants: fallback.variants,
    method: "rotation-fallback",
    quad: null,
    warpConfidence: 0
  };
};
