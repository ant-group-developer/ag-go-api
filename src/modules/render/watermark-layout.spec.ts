import {
  clipToFrame,
  fitWithin,
  getOverlayPosition,
  getRotatedSize,
  getSingleWatermarkTileScale,
  getVideoRenderSize,
  getWatermarkMargin,
  getWatermarkTileGeometry,
  getWatermarkUnitScale,
  toEvenDimension,
} from './watermark-layout';

describe('watermark layout', () => {
  it('scales authored sizes relative to a 960px frame', () => {
    expect(getWatermarkUnitScale(960)).toBe(1);
    expect(getWatermarkUnitScale(320)).toBeCloseTo(1 / 3);
    expect(getWatermarkUnitScale(3840)).toBe(4);
  });

  it('sizes a single watermark as a fraction of the frame width', () => {
    const factor = getSingleWatermarkTileScale(200, 1920, 0.25);
    expect(200 * factor).toBe(480);
  });

  it('only shrinks when fitting', () => {
    expect(fitWithin(100, 50, 400, 400)).toEqual({ width: 100, height: 50 });
    expect(fitWithin(400, 100, 200, 400)).toEqual({ width: 200, height: 50 });
    expect(fitWithin(100, 400, 400, 200)).toEqual({ width: 50, height: 200 });
  });

  it('anchors overlays with a margin', () => {
    expect(getOverlayPosition(1000, 500, 100, 50, 'top-left', 10)).toEqual({ top: 10, left: 10 });
    expect(getOverlayPosition(1000, 500, 100, 50, 'top-right', 10)).toEqual({
      top: 10,
      left: 890,
    });
    expect(getOverlayPosition(1000, 500, 100, 50, 'bottom-left', 10)).toEqual({
      top: 440,
      left: 10,
    });
    expect(getOverlayPosition(1000, 500, 100, 50, 'bottom-right', 10)).toEqual({
      top: 440,
      left: 890,
    });
    expect(getOverlayPosition(1000, 500, 100, 50, 'center', 10)).toEqual({ top: 225, left: 450 });
  });

  it('lets an oversized overlay hang off the edges opposite its anchor', () => {
    expect(getOverlayPosition(100, 100, 200, 150, 'bottom-right', 10)).toEqual({
      top: -60,
      left: -110,
    });
    expect(getOverlayPosition(100, 100, 200, 150, 'top-left', 10)).toEqual({ top: 10, left: 10 });
    expect(getOverlayPosition(100, 100, 200, 150, 'center', 10)).toEqual({ top: -25, left: -50 });
  });

  it('clips an overlay to the visible part of the frame', () => {
    expect(clipToFrame(100, 100, 50, 50, 10, 20)).toEqual({
      top: 10,
      left: 20,
      extract: { left: 0, top: 0, width: 50, height: 50 },
    });
    expect(clipToFrame(100, 100, 200, 150, -25, -50)).toEqual({
      top: 0,
      left: 0,
      extract: { left: 50, top: 25, width: 100, height: 100 },
    });
    expect(clipToFrame(100, 100, 50, 50, 120, 0)).toBeNull();
  });

  it('scales the margin and keeps corner anchors inside thin frames', () => {
    expect(getWatermarkMargin(24, 1920, 1080)).toBe(48);
    expect(getWatermarkMargin(500, 3840, 400)).toBe(199);
  });

  it('snaps the tile layout to whole pixels', () => {
    const geometry = getWatermarkTileGeometry(7.3, true, 1.1);
    for (const value of Object.values(geometry)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('computes the bounding box of a rotated tile', () => {
    expect(getRotatedSize(200, 50, 0)).toEqual({ width: 200, height: 50 });
    expect(getRotatedSize(200, 50, 90)).toEqual({ width: 50, height: 200 });
    expect(getRotatedSize(200, 50, -180)).toEqual({ width: 200, height: 50 });
    expect(getRotatedSize(100, 100, 45)).toEqual({ width: 142, height: 142 });
  });

  it('sizes the logo independently of the text', () => {
    const base = getWatermarkTileGeometry(20, true);
    const big = getWatermarkTileGeometry(20, true, 2);
    expect(big.logoSize).toBe(base.logoSize * 2);
    expect(big.textX - big.logoSize).toBeCloseTo(base.textX - base.logoSize);
    expect(getWatermarkTileGeometry(20, false, 3)).toMatchObject({ logoSize: 0, textX: 0 });
  });

  it('keeps video dimensions even', () => {
    expect(toEvenDimension(1081)).toBe(1080);
    expect(toEvenDimension(1)).toBe(2);
    expect(getVideoRenderSize(1921, 1081, {})).toEqual({ width: 1920, height: 1080 });
    expect(getVideoRenderSize(1920, 1080, { maxWidth: 1279 })).toEqual({
      width: 1278,
      height: 718,
    });
    expect(getVideoRenderSize(1080, 1920, { maxHeight: 1280 })).toEqual({
      width: 720,
      height: 1280,
    });
    expect(getVideoRenderSize(undefined, 1080, {})).toBeNull();
  });
});
