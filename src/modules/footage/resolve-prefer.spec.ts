import { pickRendition, shortEdgeOf, type Rendition } from './resolve-prefer';

const r = (
  kind: Rendition<string>['kind'],
  shortEdge: number | null,
  watermarked: boolean,
  ref = `${kind}-${shortEdge}-${watermarked}`,
): Rendition<string> => ({
  kind,
  shortEdge,
  watermarked,
  ref,
});

describe('pickRendition', () => {
  it('takes a clean 480p preview over watermarked ones and bigger files', () => {
    const picked = pickRendition(
      [
        r('preview', 270, true),
        r('preview', 480, true),
        r('preview', 480, false),
        r('proxy', 720, false),
        r('original', 1080, false),
      ],
      { short_edge: 480, clean: true },
    );
    expect(picked?.ref).toBe('preview-480-false');
  });

  it('without a clean 480p, the nearest clean one: the smallest above, else the largest below', () => {
    expect(
      pickRendition([r('preview', 540, true), r('proxy', 720, false), r('original', 2160, false)], {
        short_edge: 480,
        clean: true,
      })?.ref,
    ).toBe('proxy-720-false');
    expect(
      pickRendition([r('preview', 270, false), r('preview', 360, false), r('preview', 540, true)], {
        short_edge: 480,
        clean: true,
      })?.ref,
    ).toBe('preview-360-false');
  });

  it('a viewer who may only see watermarked previews gets the nearest of those', () => {
    expect(
      pickRendition([r('preview', 270, true), r('preview', 540, true), r('preview', 1080, true)], {
        short_edge: 480,
        clean: true,
      })?.ref,
    ).toBe('preview-540-true');
  });

  it('same size: the smaller kind; sizes unknown: the smaller kind; nothing: undefined', () => {
    expect(
      pickRendition([r('original', 480, false), r('preview', 480, false)], { short_edge: 480 })
        ?.ref,
    ).toBe('preview-480-false');
    expect(
      pickRendition([r('original', null, false), r('proxy', null, false)], { short_edge: 480 })
        ?.ref,
    ).toBe('proxy-null-false');
    expect(pickRendition([], { short_edge: 480 })).toBeUndefined();
  });

  it('short edges of portrait and landscape files', () => {
    expect(shortEdgeOf(1920, 1080)).toBe(1080);
    expect(shortEdgeOf(1080, 1920)).toBe(1080);
    expect(shortEdgeOf(undefined, 720)).toBe(720);
    expect(shortEdgeOf('x', null)).toBeNull();
  });
});
