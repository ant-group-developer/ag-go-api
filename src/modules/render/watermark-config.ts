export const WATERMARK_POSITIONS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center',
] as const;

export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number];

export type WatermarkConfig = {
  text: string;
  logoAssetId: string | null;
  color: string;
  fontFamily: string;
  fontSize: number;
  repeat: boolean;
  gapX: number;
  gapY: number;
  rotate: number;
  maxWidth: number | null;
  position: WatermarkPosition;
  opacity: number;
  scale: number;
  margin: number;
};

export const DEFAULT_WATERMARK_CONFIG: WatermarkConfig = {
  text: 'AG Go Preview',
  logoAssetId: null,
  color: '#FFFFFF',
  fontFamily: 'Arial',
  fontSize: 24,
  repeat: false,
  gapX: 220,
  gapY: 100,
  rotate: 0,
  maxWidth: null,
  position: 'bottom-right',
  opacity: 0.75,
  scale: 0.28,
  margin: 24,
};

export function normalizeWatermarkConfig(
  config: Record<string, unknown> | null | undefined,
): WatermarkConfig {
  const position = WATERMARK_POSITIONS.includes(config?.position as WatermarkPosition)
    ? (config?.position as WatermarkPosition)
    : DEFAULT_WATERMARK_CONFIG.position;
  const opacity =
    typeof config?.opacity === 'number' && Number.isFinite(config.opacity)
      ? Math.min(1, Math.max(0, config.opacity))
      : DEFAULT_WATERMARK_CONFIG.opacity;
  const scale =
    typeof config?.scale === 'number' && Number.isFinite(config.scale)
      ? Math.min(1, Math.max(0.05, config.scale))
      : DEFAULT_WATERMARK_CONFIG.scale;
  const margin =
    typeof config?.margin === 'number' && Number.isFinite(config.margin)
      ? Math.min(500, Math.max(0, Math.round(config.margin)))
      : DEFAULT_WATERMARK_CONFIG.margin;
  const fontSize =
    typeof config?.fontSize === 'number' && Number.isFinite(config.fontSize)
      ? Math.min(240, Math.max(8, Math.round(config.fontSize)))
      : DEFAULT_WATERMARK_CONFIG.fontSize;
  const gapX =
    typeof config?.gapX === 'number' && Number.isFinite(config.gapX)
      ? Math.min(2000, Math.max(40, Math.round(config.gapX)))
      : DEFAULT_WATERMARK_CONFIG.gapX;
  const gapY =
    typeof config?.gapY === 'number' && Number.isFinite(config.gapY)
      ? Math.min(2000, Math.max(40, Math.round(config.gapY)))
      : DEFAULT_WATERMARK_CONFIG.gapY;
  const rotate =
    typeof config?.rotate === 'number' && Number.isFinite(config.rotate)
      ? Math.min(360, Math.max(-360, config.rotate))
      : DEFAULT_WATERMARK_CONFIG.rotate;
  const maxWidth =
    typeof config?.maxWidth === 'number' && Number.isFinite(config.maxWidth)
      ? Math.min(10000, Math.max(1, Math.round(config.maxWidth)))
      : null;

  return {
    text:
      typeof config?.text === 'string'
        ? config.text.slice(0, 200)
        : DEFAULT_WATERMARK_CONFIG.text,
    logoAssetId:
      typeof config?.logoAssetId === 'string' && config.logoAssetId.length > 0
        ? config.logoAssetId
        : null,
    color:
      typeof config?.color === 'string' && /^#[0-9a-f]{6}$/i.test(config.color)
        ? config.color
        : DEFAULT_WATERMARK_CONFIG.color,
    fontFamily:
      typeof config?.fontFamily === 'string' && config.fontFamily.trim().length > 0
        ? config.fontFamily.trim().slice(0, 80)
        : DEFAULT_WATERMARK_CONFIG.fontFamily,
    fontSize,
    repeat: typeof config?.repeat === 'boolean' ? config.repeat : DEFAULT_WATERMARK_CONFIG.repeat,
    gapX,
    gapY,
    rotate,
    maxWidth,
    position,
    opacity,
    scale,
    margin,
  };
}

export function watermarkGravity(
  position: WatermarkPosition,
): 'northwest' | 'northeast' | 'southwest' | 'southeast' | 'center' {
  switch (position) {
    case 'top-left':
      return 'northwest';
    case 'top-right':
      return 'northeast';
    case 'bottom-left':
      return 'southwest';
    case 'center':
      return 'center';
    case 'bottom-right':
    default:
      return 'southeast';
  }
}
