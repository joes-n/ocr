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
};

const DEFAULT_TEMPLATE_LAYOUT: TicketTemplateFieldLayout = {
  name: {
    x: 0.1,
    y: 0.36,
    width: 0.56,
    height: 0.16
  },
  seat: {
    x: 0.67,
    y: 0.54,
    width: 0.21,
    height: 0.19
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
  sourceContext: CanvasRenderingContext2D
): TicketFieldROI => {
  const x = Math.round(clamp(ratios.x, 0, 1) * source.width);
  const y = Math.round(clamp(ratios.y, 0, 1) * source.height);
  const width = Math.max(1, Math.round(clamp(ratios.width, 0.02, 1) * source.width));
  const height = Math.max(1, Math.round(clamp(ratios.height, 0.02, 1) * source.height));

  const right = clamp(x + width, x + 1, source.width);
  const bottom = clamp(y + height, y + 1, source.height);
  const clippedWidth = Math.max(1, right - x);
  const clippedHeight = Math.max(1, bottom - y);

  const canvas = document.createElement("canvas");
  canvas.width = clippedWidth;
  canvas.height = clippedHeight;
  const fieldContext = canvas.getContext("2d");
  if (fieldContext) {
    fieldContext.drawImage(sourceContext.canvas, x, y, clippedWidth, clippedHeight, 0, 0, clippedWidth, clippedHeight);
  }

  return {
    region: {
      x,
      y,
      width: clippedWidth,
      height: clippedHeight
    },
    canvas
  };
};

export const extractTicketFieldROIs = (
  normalizedTicketCanvas: HTMLCanvasElement | null,
  options: TicketFieldExtractorOptions = {}
): TicketFieldROIResult => {
  const emptyFields: Record<TicketFieldKey, TicketFieldROI> = {
    name: createEmptyField(),
    seat: createEmptyField()
  };

  if (!normalizedTicketCanvas || normalizedTicketCanvas.width <= 0 || normalizedTicketCanvas.height <= 0) {
    return {
      success: false,
      fields: emptyFields
    };
  }

  const sourceContext = normalizedTicketCanvas.getContext("2d");
  if (!sourceContext) {
    return {
      success: false,
      fields: emptyFields
    };
  }

  const layout: TicketTemplateFieldLayout = {
    name: { ...DEFAULT_TEMPLATE_LAYOUT.name, ...(options.layout?.name ?? {}) },
    seat: { ...DEFAULT_TEMPLATE_LAYOUT.seat, ...(options.layout?.seat ?? {}) }
  };

  const fields: Record<TicketFieldKey, TicketFieldROI> = {
    name: makeFieldROI(normalizedTicketCanvas, layout.name, sourceContext),
    seat: makeFieldROI(normalizedTicketCanvas, layout.seat, sourceContext)
  };

  return {
    success: true,
    fields
  };
};
