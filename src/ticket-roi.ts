export type TicketFieldKey = "name" | "seat";

export type TicketFieldRatios = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TicketTemplateFieldLayout = Record<TicketFieldKey, TicketFieldRatios>;

export type TicketFieldRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TicketFieldROI = {
  region: TicketFieldRegion;
  canvas: HTMLCanvasElement;
};

export type TicketFieldROIResult = {
  success: boolean;
  fields: Record<TicketFieldKey, TicketFieldROI>;
};

export type TicketFieldExtractorOptions = {
  layout?: Partial<TicketTemplateFieldLayout>;
  clampMarginPx?: number;
};

const DEFAULT_TEMPLATE_LAYOUT: TicketTemplateFieldLayout = {
  name: {
    x: 0.205,
    y: 0.6,
    width: 0.48,
    height: 0.22
  },
  seat: {
    x: 0.205,
    y: 0.795,
    width: 0.49,
    height: 0.15
  }
};

const DEFAULT_LABEL_LAYOUT: TicketTemplateFieldLayout = {
  name: {
    x: 0.08,
    y: 0.14,
    width: 0.84,
    height: 0.46
  },
  seat: {
    x: 0.08,
    y: 0.62,
    width: 0.84,
    height: 0.3
  }
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const createEmptyField = (): TicketFieldROI => {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  return {
    region: { x: 0, y: 0, width: 1, height: 1 },
    canvas
  };
};

const makeFieldROI = (
  source: HTMLCanvasElement,
  ratios: TicketFieldRatios,
  sourceContext: CanvasRenderingContext2D,
  clampMarginPx: number
): TicketFieldROI => {
  const x = Math.round(clamp(ratios.x, 0, 1) * source.width) - clampMarginPx;
  const y = Math.round(clamp(ratios.y, 0, 1) * source.height) - clampMarginPx;
  const width = Math.max(1, Math.round(clamp(ratios.width, 0.02, 1) * source.width) + clampMarginPx * 2);
  const height = Math.max(1, Math.round(clamp(ratios.height, 0.02, 1) * source.height) + clampMarginPx * 2);

  const left = clamp(x, 0, source.width - 1);
  const top = clamp(y, 0, source.height - 1);
  const right = clamp(x + width, left + 1, source.width);
  const bottom = clamp(y + height, top + 1, source.height);
  const clippedWidth = Math.max(1, right - left);
  const clippedHeight = Math.max(1, bottom - top);

  const canvas = document.createElement("canvas");
  canvas.width = clippedWidth;
  canvas.height = clippedHeight;
  const fieldContext = canvas.getContext("2d");
  if (fieldContext) {
    fieldContext.drawImage(
      sourceContext.canvas,
      left,
      top,
      clippedWidth,
      clippedHeight,
      0,
      0,
      clippedWidth,
      clippedHeight
    );
  }

  return {
    region: {
      x: left,
      y: top,
      width: clippedWidth,
      height: clippedHeight
    },
    canvas
  };
};

const extractFieldROIsFromCanvas = (
  sourceCanvas: HTMLCanvasElement | null,
  defaultLayout: TicketTemplateFieldLayout,
  options: TicketFieldExtractorOptions = {}
): TicketFieldROIResult => {
  const emptyFields: Record<TicketFieldKey, TicketFieldROI> = {
    name: createEmptyField(),
    seat: createEmptyField()
  };

  if (!sourceCanvas || sourceCanvas.width <= 0 || sourceCanvas.height <= 0) {
    return {
      success: false,
      fields: emptyFields
    };
  }

  const sourceContext = sourceCanvas.getContext("2d");
  if (!sourceContext) {
    return {
      success: false,
      fields: emptyFields
    };
  }

  const layout: TicketTemplateFieldLayout = {
    name: { ...defaultLayout.name, ...(options.layout?.name ?? {}) },
    seat: { ...defaultLayout.seat, ...(options.layout?.seat ?? {}) }
  };
  const clampMarginPx = Math.max(0, Math.round(options.clampMarginPx ?? 4));

  const fields: Record<TicketFieldKey, TicketFieldROI> = {
    name: makeFieldROI(sourceCanvas, layout.name, sourceContext, clampMarginPx),
    seat: makeFieldROI(sourceCanvas, layout.seat, sourceContext, clampMarginPx)
  };

  return {
    success: true,
    fields
  };
};

export const extractTicketFieldROIs = (
  normalizedTicketCanvas: HTMLCanvasElement | null,
  options: TicketFieldExtractorOptions = {}
): TicketFieldROIResult => extractFieldROIsFromCanvas(normalizedTicketCanvas, DEFAULT_TEMPLATE_LAYOUT, options);

export const extractLabelFieldROIs = (
  normalizedLabelCanvas: HTMLCanvasElement | null,
  options: TicketFieldExtractorOptions = {}
): TicketFieldROIResult => extractFieldROIsFromCanvas(normalizedLabelCanvas, DEFAULT_LABEL_LAYOUT, options);
