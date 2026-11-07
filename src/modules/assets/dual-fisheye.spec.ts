import { dualFisheyeFilter, equirectSize, isDualFisheyeVideo } from './dual-fisheye';

describe('dual-fisheye', () => {
  const lens = { codec_type: 'video', width: 2880, height: 2880 };
  const audio = { codec_type: 'audio' };

  it('recognises an .insv with two matching square lenses', () => {
    expect(isDualFisheyeVideo('VID_20260909_115757_00_005.insv', [lens, lens, audio])).toBe(true);
    expect(isDualFisheyeVideo('projects/p1/originals/a.INSV', [lens, audio, lens])).toBe(true);
  });

  it('leaves other files and single-lens .insv as plain video', () => {
    expect(isDualFisheyeVideo('clip.mp4', [lens, lens])).toBe(false);
    // Older Insta360 cameras write each lens to its own .insv file.
    expect(isDualFisheyeVideo('VID_00_001.insv', [lens, audio])).toBe(false);
    expect(
      isDualFisheyeVideo('VID.insv', [lens, { codec_type: 'video', width: 1920, height: 1080 }]),
    ).toBe(false);
    expect(isDualFisheyeVideo('VID.insv', undefined)).toBe(false);
  });

  it('stitches to a 2:1 frame of the requested size', () => {
    expect(equirectSize(2880)).toEqual({ width: 5760, height: 2880 });
    expect(dualFisheyeFilter(1920, 960)).toBe(
      '[0:v:0][0:v:1]hstack=inputs=2,v360=input=dfisheye:output=e:ih_fov=200:iv_fov=200:w=1920:h=960',
    );
  });
});
