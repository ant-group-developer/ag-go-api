/**
 * Insta360 `.insv` videos are MP4 files holding each fisheye lens as its own square video
 * stream. Played as they are, only the first lens shows; previews stitch both into one 2:1
 * equirectangular frame instead, which any 360 player can show.
 *
 * The stitch is FFmpeg's plain lens model, without the camera's calibration or gyro data, so
 * the seam can show and the horizon follows the camera's tilt. Insta360 Studio does a finer job
 * for final exports; this is for previewing and picking footage.
 */

/** Field of view of each lens, in degrees (Insta360 X-series lenses see a little past 180°). */
const LENS_FOV_DEGREES = 200;

type ProbedStream = { codec_type?: string; width?: number; height?: number };

/** True for an `.insv` file whose first two video streams are matching square fisheye frames. */
export function isDualFisheyeVideo(filename: string, streams: ProbedStream[] | undefined): boolean {
  if (!/\.insv$/i.test(filename.trim())) {
    return false;
  }
  const [front, back] = (streams ?? []).filter((stream) => stream.codec_type === 'video');
  return Boolean(
    front?.width &&
    front.width === front.height &&
    back?.width === front.width &&
    back.height === front.height,
  );
}

/** Size of the stitched frame for lenses `lensSize` pixels across: twice as wide as high. */
export function equirectSize(lensSize: number): { width: number; height: number } {
  return { width: lensSize * 2, height: lensSize };
}

/**
 * Filtergraph (for `-filter_complex`) that stitches input 0's two lenses into an
 * equirectangular frame of the given size. Its output is unlabelled, so filters can follow it
 * after a comma.
 */
export function dualFisheyeFilter(width: number, height: number): string {
  return (
    `[0:v:0][0:v:1]hstack=inputs=2,` +
    `v360=input=dfisheye:output=e:ih_fov=${LENS_FOV_DEGREES}:iv_fov=${LENS_FOV_DEGREES}` +
    `:w=${width}:h=${height}`
  );
}
