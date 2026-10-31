const MIB = 1024 * 1024;

/** Larger files are uploaded in parts: a single PUT caps at 5 GB and restarts from zero on failure. */
export const MULTIPART_THRESHOLD_BYTES = 100 * MIB;
const MIN_PART_BYTES = 16 * MIB;
/** R2 and S3 accept at most 10,000 parts per upload. */
const MAX_PARTS = 10_000;

/**
 * How long the parts of an unfinished large upload are kept after its session ran out, so the
 * same file can carry on from there (after a failure, a closed tab or a computer that slept).
 */
export const MULTIPART_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MultipartLayout = { partSize: number; partCount: number };

/**
 * How a file of `sizeBytes` is split. Derived from the size alone, so the server and the
 * browser always agree on it. Every part but the last is `partSize` bytes, as R2 requires.
 */
export function multipartLayout(sizeBytes: number): MultipartLayout {
  const partSize = Math.max(MIN_PART_BYTES, Math.ceil(sizeBytes / MAX_PARTS / MIB) * MIB);
  return { partSize, partCount: Math.ceil(sizeBytes / partSize) };
}

function expectedPartSize(layout: MultipartLayout, partNumber: number, sizeBytes: number) {
  return partNumber < layout.partCount
    ? layout.partSize
    : sizeBytes - layout.partSize * (layout.partCount - 1);
}

/**
 * Parts already in storage with the size the layout expects, so a resumed upload skips them.
 * A part with any other size is sent again.
 */
export function completedPartNumbers(
  parts: Array<{ partNumber: number; sizeBytes: number }>,
  sizeBytes: number,
): number[] {
  const layout = multipartLayout(sizeBytes);
  return parts
    .filter(
      (part) =>
        part.partNumber <= layout.partCount &&
        part.sizeBytes === expectedPartSize(layout, part.partNumber, sizeBytes),
    )
    .map((part) => part.partNumber)
    .sort((a, b) => a - b);
}

/** Why the uploaded parts do not add up to the declared file, or null when they do. */
export function describePartMismatch(
  parts: Array<{ partNumber: number; sizeBytes: number }>,
  sizeBytes: number,
): string | null {
  const layout = multipartLayout(sizeBytes);
  const { partCount } = layout;
  const sizes = new Map(parts.map((part) => [part.partNumber, part.sizeBytes]));
  const missing: number[] = [];
  const wrongSize: number[] = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    const expected = expectedPartSize(layout, partNumber, sizeBytes);
    const actual = sizes.get(partNumber);
    if (actual === undefined) {
      missing.push(partNumber);
    } else if (actual !== expected) {
      wrongSize.push(partNumber);
    }
  }
  const extra = parts.filter((part) => part.partNumber > partCount).map((part) => part.partNumber);
  const problems = [
    missing.length ? `missing parts ${summarize(missing)}` : '',
    wrongSize.length ? `parts with the wrong size ${summarize(wrongSize)}` : '',
    extra.length ? `unexpected parts ${summarize(extra)}` : '',
  ].filter(Boolean);
  return problems.length ? problems.join('; ') : null;
}

function summarize(partNumbers: number[]): string {
  const shown = partNumbers.slice(0, 10).join(', ');
  return partNumbers.length > 10 ? `${shown} and ${partNumbers.length - 10} more` : shown;
}
