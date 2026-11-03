/**
 * Duration rule of the CTV rate card (BR-17, D7 "80% ≥ 20s/1 source, 20% ≥ 10s/1 source"):
 * files shorter than `minSeconds` are not sources; among the sources of a package at least
 * `preferredRatio` must last `preferredSeconds` or more. Not meeting the ratio only warns (Q-R3).
 */
export type DurationRule = {
  minSeconds: number;
  preferredSeconds: number;
  preferredRatio: number;
};

export const DEFAULT_DURATION_RULE: DurationRule = {
  minSeconds: 10,
  preferredSeconds: 20,
  preferredRatio: 0.8,
};

/** Counts of the candidate videos of one project (or package) under a duration rule. */
export type SourceCounts = {
  /** Candidate video files. */
  files: number;
  /** Shorter than `minSeconds`: not sources. */
  shortFiles: number;
  /** No known duration yet (no analysis): not sources until analysed. */
  unknownDuration: number;
  /** Sources: at least `minSeconds`. */
  validSources: number;
  /** Sources of at least `preferredSeconds`. */
  preferredSources: number;
};

export const EMPTY_SOURCE_COUNTS: SourceCounts = {
  files: 0,
  shortFiles: 0,
  unknownDuration: 0,
  validSources: 0,
  preferredSources: 0,
};

/**
 * Counts from the durations (seconds, null = unknown). The SQL of the services computes the same
 * counts with `FILTER` (NFR-01); this is the reference used by the tests.
 */
export function countSources(
  durationsSeconds: ReadonlyArray<number | null>,
  rule: DurationRule,
): SourceCounts {
  const counts = { ...EMPTY_SOURCE_COUNTS };
  for (const seconds of durationsSeconds) {
    counts.files += 1;
    if (seconds === null || !Number.isFinite(seconds)) {
      counts.unknownDuration += 1;
    } else if (seconds < rule.minSeconds) {
      counts.shortFiles += 1;
    } else {
      counts.validSources += 1;
      if (seconds >= rule.preferredSeconds) {
        counts.preferredSources += 1;
      }
    }
  }
  return counts;
}

export function addSourceCounts(left: SourceCounts, right: SourceCounts): SourceCounts {
  return {
    files: left.files + right.files,
    shortFiles: left.shortFiles + right.shortFiles,
    unknownDuration: left.unknownDuration + right.unknownDuration,
    validSources: left.validSources + right.validSources,
    preferredSources: left.preferredSources + right.preferredSources,
  };
}

export type DurationRatio = {
  /** preferred / valid, rounded to 4 decimals; null without sources. */
  ratio: number | null;
  met: boolean;
};

/** The 80/20 check over a whole package (Q-R3). No sources: nothing to warn about. */
export function durationRatio(
  validSources: number,
  preferredSources: number,
  rule: DurationRule,
): DurationRatio {
  if (validSources <= 0) {
    return { ratio: null, met: true };
  }
  const ratio = Math.round((preferredSources / validSources) * 10_000) / 10_000;
  // Integer comparison avoids 0.8 × n floating noise: preferred × 10000 ≥ ratio × 10000 × valid.
  const met = preferredSources * 10_000 >= Math.round(rule.preferredRatio * 10_000) * validSources;
  return { ratio, met };
}

/** "73,9%" */
export function formatPercent(ratio: number): string {
  return `${(Math.round(ratio * 1000) / 10).toString().replace('.', ',')}%`;
}
