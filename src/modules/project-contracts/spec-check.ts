import { createHash } from 'node:crypto';
import type { PricingModel } from '../../database/entities/contract.entity';
import type { SpecCheckResult } from '../../database/entities/media-spec-check.entity';
import { TechSpecSchema, type TechSpec } from '../contracts/contract-terms';

/**
 * Automatic technical checks of delivered videos against a contract's tech spec (spec 8, FR-T-02,
 * FR-T-03). Pure functions: the service loads the analysis data and stores the results.
 *
 * Bump when a rule changes: every stored result then counts as stale and is checked again.
 */
export const SPEC_CHECKER_VERSION = 1;

export type SpecLevel = SpecCheckResult;

export type SpecRule =
  | 'analysis'
  | 'resolution'
  | 'fps'
  | 'min_shot_seconds'
  | 'source_min_seconds'
  | 'audio'
  | 'dead'
  | 'usable'
  | 'quality'
  | 'media'
  | 'min_shots_per_scene'
  | 'min_topic_minutes'
  | 'max_topic_minutes'
  | 'source_duration_ratio'
  | 'uniform_within_project';

export type SpecFinding = {
  rule: SpecRule;
  level: SpecLevel;
  expected?: unknown;
  actual?: unknown;
  /** Short Vietnamese explanation for the evaluation screen. */
  message: string;
};

/** The rules applied, resolved from the terms in force (tech spec plus model-specific terms). */
export type CheckRules = {
  minWidth: number | null;
  minHeight: number | null;
  fps: { target: number; tolerance: number } | null;
  /** Shorter videos fail (per_unit shot, D4). */
  minShotSeconds: number | null;
  /** Shorter videos are not counted as sources (package_tier, BR-17); warning only. */
  sourceMinSeconds: number | null;
  sourcePreferredSeconds: number | null;
  sourcePreferredRatio: number | null;
  /** true: no audio fails; undefined: warns; false: not checked. */
  requireAudio: boolean | undefined;
  rejectDead: boolean;
  /** 0–1, compared with the AI quality score (0–5) divided by 5. */
  minQuality: number | null;
  minShotsPerScene: number | null;
  minTopicMinutes: number | null;
  maxTopicMinutes: number | null;
  uniformWithinProject: boolean;
};

export type TermsForChecks = {
  pricing_model: PricingModel;
  pricing_config: Record<string, unknown>;
  tech_spec: Record<string, unknown>;
};

/** What the checks read of a video: its current analysis, or why there is none. */
export type MediaFacts = {
  /** Current completed analysis; null when the video was never analysed (or not yet). */
  analysisId: string | null;
  /** Status of an analysis still running, when there is no current one. */
  pendingAnalysisStatus: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  durationMs: number | null;
  hasAudio: boolean | null;
  usable: boolean | null;
  usableReason: string | null;
  /** AI score 0–5. */
  quality: number | null;
  dead: boolean;
  deadReason: string | null;
};

export type MediaCheck = { result: SpecLevel; findings: SpecFinding[] };

const LEVEL_RANK: Record<SpecLevel, number> = { pass: 0, warn: 1, unknown: 2, fail: 3 };

/**
 * The worst level: fail > unknown > warn > pass. `unknown` ranks above `warn` because an incomplete
 * check must not look better than a warning (spec 8.2: unknown media can block an acceptance).
 */
export function worstLevel(levels: Iterable<SpecLevel>): SpecLevel {
  let worst: SpecLevel = 'pass';
  for (const level of levels) {
    if (LEVEL_RANK[level] > LEVEL_RANK[worst]) {
      worst = level;
    }
  }
  return worst;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Rules from the terms in force: the tech spec first, then the terms of the pricing model it does
 * not repeat (`per_unit.min_shot_seconds`, `per_topic.min_topic_minutes` / `max_topic_minutes` /
 * `require_audio`). A tech spec that no longer parses is read field by field.
 */
export function resolveCheckRules(terms: TermsForChecks): CheckRules {
  const parsed = TechSpecSchema.safeParse(terms.tech_spec ?? {});
  const spec: TechSpec = parsed.success ? parsed.data : ((terms.tech_spec ?? {}) as TechSpec);
  const config = terms.pricing_config ?? {};
  const perUnit = terms.pricing_model === 'per_unit';
  const perTopic = terms.pricing_model === 'per_topic';
  const fps =
    spec.fps && positiveNumber(spec.fps.target) !== null
      ? { target: spec.fps.target, tolerance: nonNegativeNumber(spec.fps.tolerance) ?? 0 }
      : null;
  const sourceRule = spec.source_duration_rule ?? null;
  const requireAudio =
    typeof spec.require_audio === 'boolean'
      ? spec.require_audio
      : perTopic && typeof config.require_audio === 'boolean'
        ? config.require_audio
        : undefined;
  return {
    minWidth: positiveNumber(spec.min_width),
    minHeight: positiveNumber(spec.min_height),
    fps,
    minShotSeconds:
      nonNegativeNumber(spec.min_shot_seconds) ??
      (perUnit ? nonNegativeNumber(config.min_shot_seconds) : null),
    sourceMinSeconds: sourceRule ? nonNegativeNumber(sourceRule.min_seconds) : null,
    sourcePreferredSeconds: sourceRule ? nonNegativeNumber(sourceRule.preferred_seconds) : null,
    sourcePreferredRatio: sourceRule ? nonNegativeNumber(sourceRule.preferred_ratio) : null,
    requireAudio,
    rejectDead: spec.reject_dead !== false,
    minQuality: nonNegativeNumber(spec.min_quality),
    minShotsPerScene: positiveNumber(spec.min_shots_per_scene),
    minTopicMinutes:
      positiveNumber(spec.min_topic_minutes) ??
      (perTopic ? positiveNumber(config.min_topic_minutes) : null),
    maxTopicMinutes: perTopic ? positiveNumber(config.max_topic_minutes) : null,
    uniformWithinProject: spec.uniform_within_project === true,
  };
}

/** Stable JSON: keys sorted at every level. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** `spec_hash` of 7.5: the rules applied and the checker version. */
export function specHash(rules: CheckRules): string {
  return createHash('sha256')
    .update(canonical({ version: SPEC_CHECKER_VERSION, rules }))
    .digest('hex');
}

function seconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}

function resolutionLabel(width: number, height: number): string {
  return `${width}x${height}`;
}

/**
 * Checks one video (spec 8.2). Without a current analysis the result is `unknown`. Each rule the
 * contract sets gives one finding, passed ones included, so the screen can show the checklist.
 */
export function checkMedia(rules: CheckRules, facts: MediaFacts): MediaCheck {
  if (!facts.analysisId) {
    const finding: SpecFinding = {
      rule: 'analysis',
      level: 'unknown',
      actual: facts.pendingAnalysisStatus ?? 'missing',
      message: facts.pendingAnalysisStatus
        ? `Đang phân tích (${facts.pendingAnalysisStatus}), chưa kiểm tra được`
        : 'Chưa có kết quả phân tích, chưa kiểm tra được',
    };
    return { result: 'unknown', findings: [finding] };
  }

  const findings: SpecFinding[] = [];

  if (rules.minWidth !== null || rules.minHeight !== null) {
    findings.push(checkResolution(rules, facts));
  }

  if (rules.fps) {
    const { target, tolerance } = rules.fps;
    if (facts.fps === null) {
      findings.push({
        rule: 'fps',
        level: 'unknown',
        expected: rules.fps,
        actual: null,
        message: 'Không đọc được FPS',
      });
    } else {
      const ok = Math.abs(facts.fps - target) <= tolerance + 1e-9;
      findings.push({
        rule: 'fps',
        level: ok ? 'pass' : 'fail',
        expected: rules.fps,
        actual: facts.fps,
        message: ok
          ? `FPS ${facts.fps} đạt (${target} ± ${tolerance})`
          : `FPS ${facts.fps} không đạt (yêu cầu ${target} ± ${tolerance})`,
      });
    }
  }

  if (rules.minShotSeconds !== null) {
    findings.push(
      durationFinding('min_shot_seconds', rules.minShotSeconds, facts.durationMs, 'fail', {
        pass: (actual) => `Dài ${actual}s, đạt tối thiểu ${rules.minShotSeconds}s/shot`,
        miss: (actual) => `Dài ${actual}s, ngắn hơn ${rules.minShotSeconds}s/shot`,
      }),
    );
  }

  if (rules.sourceMinSeconds !== null) {
    findings.push(
      durationFinding('source_min_seconds', rules.sourceMinSeconds, facts.durationMs, 'warn', {
        pass: (actual) => `Dài ${actual}s, được tính là source (≥ ${rules.sourceMinSeconds}s)`,
        miss: (actual) =>
          `Dài ${actual}s, ngắn hơn ${rules.sourceMinSeconds}s nên không được tính là source`,
      }),
    );
  }

  if (rules.requireAudio !== false) {
    if (facts.hasAudio === null) {
      if (rules.requireAudio === true) {
        findings.push({
          rule: 'audio',
          level: 'unknown',
          expected: true,
          actual: null,
          message: 'Không rõ có âm thanh hay không',
        });
      }
    } else if (facts.hasAudio) {
      if (rules.requireAudio === true) {
        findings.push({
          rule: 'audio',
          level: 'pass',
          expected: true,
          actual: true,
          message: 'Có âm thanh',
        });
      }
    } else {
      findings.push({
        rule: 'audio',
        level: rules.requireAudio === true ? 'fail' : 'warn',
        expected: true,
        actual: false,
        message:
          rules.requireAudio === true
            ? 'Không có âm thanh (HĐ yêu cầu có âm thanh)'
            : 'Không có âm thanh',
      });
    }
  }

  if (rules.rejectDead) {
    if (facts.dead) {
      findings.push({
        rule: 'dead',
        level: 'fail',
        expected: null,
        actual: facts.deadReason ?? 'dead',
        message: `Video hỏng về kỹ thuật: ${deadLabel(facts.deadReason)}`,
      });
    } else {
      findings.push({
        rule: 'dead',
        level: 'pass',
        expected: null,
        actual: null,
        message: 'Không đen / đứng hình / mờ',
      });
      if (facts.usable === false) {
        findings.push({
          rule: 'usable',
          level: 'fail',
          expected: true,
          actual: false,
          message: facts.usableReason
            ? `AI đánh giá không dùng được: ${facts.usableReason}`
            : 'AI đánh giá không dùng được',
        });
      }
    }
  }

  if (rules.minQuality !== null && !facts.dead) {
    if (facts.quality === null) {
      findings.push({
        rule: 'quality',
        level: 'unknown',
        expected: rules.minQuality,
        actual: null,
        message: 'Chưa có điểm chất lượng',
      });
    } else {
      const score = facts.quality / 5;
      const ok = score + 1e-9 >= rules.minQuality;
      findings.push({
        rule: 'quality',
        level: ok ? 'pass' : 'warn',
        expected: rules.minQuality,
        actual: facts.quality,
        message: ok
          ? `Điểm chất lượng ${facts.quality}/5 đạt`
          : `Điểm chất lượng ${facts.quality}/5 thấp hơn ngưỡng ${Math.round(rules.minQuality * 5 * 10) / 10}/5`,
      });
    }
  }

  return { result: worstLevel(findings.map((finding) => finding.level)), findings };
}

function checkResolution(rules: CheckRules, facts: MediaFacts): SpecFinding {
  const expected = { min_width: rules.minWidth, min_height: rules.minHeight };
  if (facts.width === null || facts.height === null) {
    return {
      rule: 'resolution',
      level: 'unknown',
      expected,
      actual: null,
      message: 'Không đọc được độ phân giải',
    };
  }
  // Long side against the long requirement, short against short: portrait videos are accepted.
  const long = Math.max(facts.width, facts.height);
  const short = Math.min(facts.width, facts.height);
  let ok: boolean;
  let required: string;
  if (rules.minWidth !== null && rules.minHeight !== null) {
    const requiredLong = Math.max(rules.minWidth, rules.minHeight);
    const requiredShort = Math.min(rules.minWidth, rules.minHeight);
    ok = long >= requiredLong && short >= requiredShort;
    required = resolutionLabel(rules.minWidth, rules.minHeight);
  } else if (rules.minWidth !== null) {
    ok = long >= rules.minWidth;
    required = `cạnh dài ≥ ${rules.minWidth}`;
  } else {
    ok = short >= (rules.minHeight ?? 0);
    required = `cạnh ngắn ≥ ${rules.minHeight}`;
  }
  const actual = resolutionLabel(facts.width, facts.height);
  return {
    rule: 'resolution',
    level: ok ? 'pass' : 'fail',
    expected,
    actual,
    message: ok ? `Độ phân giải ${actual} đạt` : `Độ phân giải ${actual} thấp hơn ${required}`,
  };
}

function durationFinding(
  rule: 'min_shot_seconds' | 'source_min_seconds',
  minSeconds: number,
  durationMs: number | null,
  missLevel: SpecLevel,
  messages: { pass: (actual: number) => string; miss: (actual: number) => string },
): SpecFinding {
  if (durationMs === null) {
    return {
      rule,
      level: 'unknown',
      expected: minSeconds,
      actual: null,
      message: 'Không đọc được thời lượng',
    };
  }
  const actual = seconds(durationMs);
  const ok = durationMs >= minSeconds * 1000;
  return {
    rule,
    level: ok ? 'pass' : missLevel,
    expected: minSeconds,
    actual,
    message: ok ? messages.pass(actual) : messages.miss(actual),
  };
}

function deadLabel(reason: string | null): string {
  switch (reason) {
    case 'black':
      return 'màn hình đen';
    case 'frozen':
      return 'đứng hình';
    case 'blurry':
      return 'mờ';
    default:
      return 'không dùng được';
  }
}

export type ProjectMediaForSummary = {
  evaluationStatus: 'pending' | 'approved' | 'rejected';
  result: SpecLevel;
  facts: MediaFacts;
};

export type ProjectSpecSummary = {
  result: SpecLevel;
  /** Videos by result; rejected ones are counted in `rejected`, not in the results. */
  counts: { total: number; pass: number; warn: number; fail: number; unknown: number };
  rejected: number;
  approvedVideos: number;
  pendingVideos: number;
  /** Total duration of approved videos (those with a known duration). */
  approvedDurationMs: number;
  findings: SpecFinding[];
};

/**
 * Project-level checks (FR-T-03, spec 8.2): worst result of the videos still in play (rejected ones
 * are left out, they are never paid), shots per scene and topic duration over approved videos
 * (`unknown` while media still wait for evaluation and the count can still be reached), the 80/20
 * duration ratio and uniform resolution / fps.
 */
export function summarizeProject(
  rules: CheckRules,
  media: readonly ProjectMediaForSummary[],
): ProjectSpecSummary {
  const live = media.filter((item) => item.evaluationStatus !== 'rejected');
  const approved = media.filter((item) => item.evaluationStatus === 'approved');
  const pending = media.filter((item) => item.evaluationStatus === 'pending');
  const counts = { total: live.length, pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const item of live) {
    counts[item.result] += 1;
  }
  const findings: SpecFinding[] = [];

  if (live.length > 0) {
    const level = worstLevel(live.map((item) => item.result));
    findings.push({
      rule: 'media',
      level,
      actual: { ...counts },
      message:
        level === 'pass'
          ? `${counts.pass}/${counts.total} video đạt`
          : `${counts.fail} không đạt, ${counts.unknown} chưa kiểm tra được, ${counts.warn} cảnh báo / ${counts.total} video`,
    });
  }

  if (rules.minShotsPerScene !== null) {
    const min = rules.minShotsPerScene;
    const ok = approved.length >= min;
    findings.push({
      rule: 'min_shots_per_scene',
      level: ok ? 'pass' : pending.length > 0 ? 'unknown' : 'warn',
      expected: min,
      actual: { approved: approved.length, pending: pending.length },
      message: ok
        ? `${approved.length} shot đã duyệt, đạt tối thiểu ${min}/bối cảnh`
        : pending.length > 0
          ? `${approved.length}/${min} shot đã duyệt, còn ${pending.length} chờ duyệt`
          : `Chỉ ${approved.length}/${min} shot đã duyệt cho bối cảnh`,
    });
  }

  const durations = approved.map((item) => item.facts.durationMs);
  const knownDurations = durations.filter((value): value is number => value !== null);
  const approvedDurationMs = knownDurations.reduce((sum, value) => sum + value, 0);
  const missingDurations = durations.length - knownDurations.length;
  const minutes = Math.round((approvedDurationMs / 60000) * 10) / 10;

  if (rules.minTopicMinutes !== null) {
    const min = rules.minTopicMinutes;
    const ok = approvedDurationMs >= min * 60000;
    const open = pending.length > 0 || missingDurations > 0;
    findings.push({
      rule: 'min_topic_minutes',
      level: ok ? 'pass' : open ? 'unknown' : 'fail',
      expected: min,
      actual: minutes,
      message: ok
        ? `Tổng ${minutes} phút video đã duyệt, đạt tối thiểu ${min} phút`
        : open
          ? `Mới có ${minutes}/${min} phút video đã duyệt (còn video chờ duyệt hoặc chưa rõ thời lượng)`
          : `Tổng ${minutes} phút video đã duyệt, chưa đủ ${min} phút: chủ đề không được tính tiền`,
    });
  }

  if (rules.maxTopicMinutes !== null && approvedDurationMs > rules.maxTopicMinutes * 60000) {
    findings.push({
      rule: 'max_topic_minutes',
      level: 'warn',
      expected: rules.maxTopicMinutes,
      actual: minutes,
      message: `Tổng ${minutes} phút, vượt ${rules.maxTopicMinutes} phút (chỉ cảnh báo)`,
    });
  }

  if (rules.sourcePreferredSeconds !== null && rules.sourcePreferredRatio !== null) {
    const minMs = (rules.sourceMinSeconds ?? 0) * 1000;
    const sources = knownDurations.filter((value) => value >= minMs);
    if (sources.length > 0) {
      const long = sources.filter((value) => value >= rules.sourcePreferredSeconds! * 1000).length;
      const ratio = long / sources.length;
      const ok = ratio + 1e-9 >= rules.sourcePreferredRatio;
      const percent = Math.round(ratio * 1000) / 10;
      findings.push({
        rule: 'source_duration_ratio',
        level: ok ? 'pass' : 'warn',
        expected: {
          preferred_seconds: rules.sourcePreferredSeconds,
          preferred_ratio: rules.sourcePreferredRatio,
        },
        actual: { sources: sources.length, long, ratio: Math.round(ratio * 1000) / 1000 },
        message: ok
          ? `${percent}% source dài ≥ ${rules.sourcePreferredSeconds}s`
          : `Chỉ ${percent}% source dài ≥ ${rules.sourcePreferredSeconds}s (yêu cầu ${Math.round(rules.sourcePreferredRatio * 100)}%), xét lại ở cấp gói`,
      });
    }
  }

  if (rules.uniformWithinProject) {
    const groups = new Map<string, number>();
    for (const item of live) {
      const { width, height, fps } = item.facts;
      if (!item.facts.analysisId || width === null || height === null) {
        continue;
      }
      const key = `${Math.max(width, height)}x${Math.min(width, height)}@${fps === null ? '?' : Math.round(fps * 100) / 100}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    if (groups.size > 0) {
      const formats = [...groups.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([format, count]) => ({ format, count }));
      findings.push({
        rule: 'uniform_within_project',
        level: groups.size === 1 ? 'pass' : 'warn',
        expected: 'same resolution and fps',
        actual: formats,
        message:
          groups.size === 1
            ? `Mọi video cùng thông số ${formats[0].format}`
            : `Video không đồng nhất: ${formats.map((item) => `${item.format} (${item.count})`).join(', ')}`,
      });
    }
  }

  return {
    result: worstLevel(findings.map((finding) => finding.level)),
    counts,
    rejected: media.length - live.length,
    approvedVideos: approved.length,
    pendingVideos: pending.length,
    approvedDurationMs,
    findings,
  };
}

/** Raw columns of a video, its asset and its current analysis, as the service reads them. */
export type MediaFactsRow = {
  analysisId: string | null;
  pendingAnalysisStatus: string | null;
  durationMs: number | null;
  hasAudio: boolean | null;
  usable: boolean | null;
  quality: number | null;
  technical: Record<string, unknown> | null;
  /** `artifacts.media` of the analysis (extract manifest media, sized as the original). */
  media: Record<string, unknown> | null;
  /** `description.usable_reason` of the analysis. */
  usableReason: string | null;
  sourceMetadata: Record<string, unknown> | null;
};

/**
 * Facts of a video. Width / height / fps come from the extract manifest (`artifacts.media`, sized
 * as the original file), falling back to the asset's own metadata for the size; dead and its reason
 * from `technical` (farm scan.ts `AssetTechnical`).
 */
export function mediaFacts(row: MediaFactsRow): MediaFacts {
  const media = row.media;
  const metadata = row.sourceMetadata ?? {};
  const technical = row.technical ?? {};
  const deadReason = typeof technical.dead_reason === 'string' ? technical.dead_reason : null;
  return {
    analysisId: row.analysisId,
    pendingAnalysisStatus: row.analysisId ? null : row.pendingAnalysisStatus,
    width: positiveNumber(media?.width) ?? positiveNumber(numberLike(metadata.width)),
    height: positiveNumber(media?.height) ?? positiveNumber(numberLike(metadata.height)),
    fps: positiveNumber(media?.fps),
    durationMs: nonNegativeNumber(row.durationMs),
    hasAudio: row.hasAudio,
    usable: row.usable,
    usableReason: row.usableReason?.trim() || null,
    quality: nonNegativeNumber(row.quality),
    dead: technical.dead === true || deadReason !== null,
    deadReason,
  };
}

function numberLike(value: unknown): number | null {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}
