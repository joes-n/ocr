export type TicketBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TicketLocalizationResult = {
  ticketFound: boolean;
  labelFound: boolean;
  ticketBox: TicketBoundingBox | null;
  labelBox: TicketBoundingBox | null;
  box: TicketBoundingBox;
  confidence: number;
  debug?: {
    stage: string;
    ticketScore: number;
    labelScore: number;
    frameLighting: string;
    reasons: string[];
  };
};

export type LocalizerOptions = {
  debug?: boolean;
};

const SAMPLE_WIDTH = 400;
const hiddenCanvas = document.createElement("canvas");
const hiddenCtx = hiddenCanvas.getContext("2d", { willReadFrequently: true });

export const localizeTicketFromVideoFrame = (
  source: HTMLVideoElement | HTMLCanvasElement,
  options: LocalizerOptions = {}
): TicketLocalizationResult => {
  const videoWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const videoHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.height;

  const defaultBox: TicketBoundingBox = {
    x: videoWidth * 0.1,
    y: videoHeight * 0.1,
    width: videoWidth * 0.8,
    height: videoHeight * 0.8
  };

  if (videoWidth === 0 || videoHeight === 0 || !hiddenCtx) {
    return {
      ticketFound: false,
      labelFound: false,
      ticketBox: null,
      labelBox: null,
      box: defaultBox,
      confidence: 0,
      debug: options.debug ? {
        stage: "init",
        ticketScore: 0,
        labelScore: 0,
        frameLighting: "unknown",
        reasons: ["Invalid source dimensions"]
      } : undefined
    };
  }

  // 1. Downsample
  const aspect = videoHeight / videoWidth;
  const sampleHeight = Math.round(SAMPLE_WIDTH * aspect);
  hiddenCanvas.width = SAMPLE_WIDTH;
  hiddenCanvas.height = sampleHeight;
  hiddenCtx.drawImage(source, 0, 0, SAMPLE_WIDTH, sampleHeight);

  const imageData = hiddenCtx.getImageData(0, 0, SAMPLE_WIDTH, sampleHeight);
  const data = imageData.data;

  // 2. Color Segmentation
  let minTx = SAMPLE_WIDTH, minTy = sampleHeight, maxTx = 0, maxTy = 0;
  let ticketPixelCount = 0;

  let minLx = SAMPLE_WIDTH, minLy = sampleHeight, maxLx = 0, maxLy = 0;
  let labelPixelCount = 0;

  for (let y = 0; y < sampleHeight; y++) {
    for (let x = 0; x < SAMPLE_WIDTH; x++) {
      const idx = (y * SAMPLE_WIDTH + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // Blue detection (Ticket)
      // Heuristic: Blue is dominant and sufficiently bright
      if (b > 80 && b > r + 15 && b > g + 10) {
        minTx = Math.min(minTx, x);
        minTy = Math.min(minTy, y);
        maxTx = Math.max(maxTx, x);
        maxTy = Math.max(maxTy, y);
        ticketPixelCount++;
      }

      // White detection (Label)
      // Heuristic: High RGB values, balanced
      if (r > 170 && g > 170 && b > 170 && Math.abs(r - g) < 30 && Math.abs(g - b) < 30) {
        minLx = Math.min(minLx, x);
        minLy = Math.min(minLy, y);
        maxLx = Math.max(maxLx, x);
        maxLy = Math.max(maxLy, y);
        labelPixelCount++;
      }
    }
  }

  // 3. Heuristics & Validation
  const scaleX = videoWidth / SAMPLE_WIDTH;
  const scaleY = videoHeight / sampleHeight;

  const ticketWidth = maxTx - minTx;
  const ticketHeight = maxTy - minTy;
  const ticketArea = ticketWidth * ticketHeight;
  const ticketDensity = ticketArea > 0 ? ticketPixelCount / ticketArea : 0;
  const ticketAspect = ticketWidth / ticketHeight;
  
  const ticketFound = ticketPixelCount > 500 && ticketDensity > 0.3 && ticketAspect > 1.2 && ticketAspect < 3.0;
  
  const ticketBox: TicketBoundingBox | null = ticketFound ? {
    x: minTx * scaleX,
    y: minTy * scaleY,
    width: ticketWidth * scaleX,
    height: ticketHeight * scaleY
  } : null;

  const labelWidth = maxLx - minLx;
  const labelHeight = maxLy - minLy;
  const labelArea = labelWidth * labelHeight;
  const labelDensity = labelArea > 0 ? labelPixelCount / labelArea : 0;
  const labelAspect = labelWidth / labelHeight;

  // Label should be inside or mostly overlapping the ticket
  const isInsideTicket = ticketFound && 
    minLx >= minTx - 10 && maxLx <= maxTx + 10 && 
    minLy >= minTy - 10 && maxLy <= maxTy + 10;

  const labelFound = labelPixelCount > 200 && labelDensity > 0.4 && labelAspect > 1.5 && labelAspect < 4.0 && (ticketFound ? isInsideTicket : true);

  const labelBox: TicketBoundingBox | null = labelFound ? {
    x: minLx * scaleX,
    y: minLy * scaleY,
    width: labelWidth * scaleX,
    height: labelHeight * scaleY
  } : null;

  return {
    ticketFound,
    labelFound,
    ticketBox,
    labelBox,
    box: ticketBox ?? labelBox ?? defaultBox,
    confidence: ticketFound ? (labelFound ? 0.95 : 0.7) : (labelFound ? 0.4 : 0),
    debug: options.debug ? {
      stage: "post-process",
      ticketScore: ticketDensity,
      labelScore: labelDensity,
      frameLighting: "normal",
      reasons: []
    } : undefined
  };
};
