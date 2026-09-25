import {
  fitWithin,
  getOverlayPosition,
  getSingleWatermarkTileScale,
  getVideoRenderSize,
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

  it('never places an overlay outside the frame', () => {
    expect(getOverlayPosition(100, 100, 100, 100, 'bottom-right', 24)).toEqual({
      top: 0,
      left: 0,
    });
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
