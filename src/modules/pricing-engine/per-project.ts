import type { PricingWarning } from './package-tier';
import { PricingError } from './pricing-error';

/**
 * Models paid per project content, gathered straight from the delivered projects of a contract
 * (no package): `per_topic` (BR-10), `per_unit` shot / clip (BR-11, BR-12) and `per_source`
 * (Lái xe / Flycam, BR-16). Inputs are per-project counts the services aggregate in SQL (NFR-01).
 */

export type ProjectLine = {
  projectId: string;
  counted: boolean;
  /** Units the project brings (topics, shots, clips or sources). */
  quantity: number;
  reason: string | null;
  message: string | null;
  /** Excluded media by reason, e.g. `{ below_min_duration: 1 }`. */
  excluded: Record<string, number>;
};

export type PerProjectResult = {
  quantity: number;
  unitPrice: number;
  amount: number;
  projects: ProjectLine[];
  warnings: PricingWarning[];
};

function requirePrice(unitPrice: number): void {
  if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) {
    throw new PricingError('INVALID_AMOUNT', 'Đơn giá phải là số nguyên không âm (đồng).');
  }
}

function nonZero(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).filter(([, count]) => count > 0));
}

function finish(unitPrice: number, projects: ProjectLine[], warnings: PricingWarning[]) {
  const quantity = projects.reduce((sum, project) => sum + project.quantity, 0);
  return { quantity, unitPrice, amount: quantity * unitPrice, projects, warnings };
}

// ---------------------------------------------------------------------------
// per_topic
// ---------------------------------------------------------------------------

export type PerTopicTerms = {
  unitPrice: number;
  minTopicMinutes: number;
  /** Warning only: longer topics are not cut. */
  maxTopicMinutes?: number | null;
};

export type TopicProjectFacts = {
  projectId: string;
  /** Total duration of the approved videos, seconds. */
  approvedSeconds: number;
  /** Media still pending evaluation (block the topic, BR-10 / BR-21). */
  pendingMedia: number;
  /** Approved videos without a known duration (not analysed). */
  unknownDuration: number;
};

/** "18 phút" from seconds, rounded down to the minute. */
function minutesOf(seconds: number): number {
  return Math.floor(seconds / 60);
}

/**
 * BR-10: a project is one topic when no media is pending and its approved videos last at least
 * `minTopicMinutes`. Amount = topics × unit price.
 */
export function computePerTopic(
  terms: PerTopicTerms,
  projects: readonly TopicProjectFacts[],
): PerProjectResult {
  requirePrice(terms.unitPrice);
  const minSeconds = terms.minTopicMinutes * 60;
  const warnings: PricingWarning[] = [];
  const lines = projects.map((project): ProjectLine => {
    const excluded = nonZero({ unknown_duration: project.unknownDuration });
    if (project.pendingMedia > 0) {
      return {
        projectId: project.projectId,
        counted: false,
        quantity: 0,
        reason: 'pending_media',
        message: `Còn ${project.pendingMedia} media chưa nghiệm thu`,
        excluded,
      };
    }
    if (project.approvedSeconds < minSeconds) {
      const missing = Math.ceil((minSeconds - project.approvedSeconds) / 60);
      return {
        projectId: project.projectId,
        counted: false,
        quantity: 0,
        reason: 'below_min_minutes',
        message: `Thiếu ${missing} phút so với tối thiểu ${terms.minTopicMinutes} phút`,
        excluded,
      };
    }
    if (terms.maxTopicMinutes && project.approvedSeconds > terms.maxTopicMinutes * 60) {
      warnings.push({
        code: 'OVER_MAX_MINUTES',
        message: `Dự án ${project.projectId} dài ${minutesOf(project.approvedSeconds)} phút, vượt ${terms.maxTopicMinutes} phút (vẫn tính 1 chủ đề)`,
      });
    }
    return {
      projectId: project.projectId,
      counted: true,
      quantity: 1,
      reason: null,
      message: null,
      excluded,
    };
  });
  return finish(terms.unitPrice, lines, warnings);
}

// ---------------------------------------------------------------------------
// per_unit
// ---------------------------------------------------------------------------

export type PerUnitTerms = {
  unit: 'shot' | 'clip';
  unitPrice: number;
  maxShotsPerClip?: number | null;
  minShotSeconds?: number | null;
};

export type ShotProjectFacts = {
  projectId: string;
  /** Approved videos that qualify as shots. */
  shots: number;
  /** Approved but shorter than `minShotSeconds`. */
  belowMinDuration: number;
  /** Approved without a known duration while a minimum applies. */
  unknownDuration: number;
  /** Technical check `fail` approved without a reason (BR-11, FR-T-04). */
  specFail: number;
};

export type ShotMediaFacts = {
  durationSeconds: number | null;
  specResult: 'pass' | 'warn' | 'fail' | 'unknown' | null;
  /** The approval of a failed media carries a reason (FR-T-04). */
  approvedWithReason: boolean;
};

/**
 * Per-project counts of approved videos for BR-11 (reference for the SQL of the services): a shot
 * lasts at least `minShotSeconds` and is not a technical `fail`, unless approved with a reason.
 */
export function countShots(
  projectId: string,
  media: readonly ShotMediaFacts[],
  minShotSeconds: number | null | undefined,
): ShotProjectFacts {
  const facts: ShotProjectFacts = {
    projectId,
    shots: 0,
    belowMinDuration: 0,
    unknownDuration: 0,
    specFail: 0,
  };
  for (const item of media) {
    if (minShotSeconds && item.durationSeconds === null) {
      facts.unknownDuration += 1;
    } else if (minShotSeconds && (item.durationSeconds as number) < minShotSeconds) {
      facts.belowMinDuration += 1;
    } else if (item.specResult === 'fail' && !item.approvedWithReason) {
      facts.specFail += 1;
    } else {
      facts.shots += 1;
    }
  }
  return facts;
}

/**
 * BR-11 / BR-12: quantity = qualifying shots, or per project ⌈shots / maxShotsPerClip⌉ clips (Q7:
 * rounded up, 7 shots = 2 clips).
 */
export function computePerUnit(
  terms: PerUnitTerms,
  projects: readonly ShotProjectFacts[],
): PerProjectResult {
  requirePrice(terms.unitPrice);
  if (terms.unit === 'clip' && !(terms.maxShotsPerClip && terms.maxShotsPerClip > 0)) {
    throw new PricingError('INVALID_INPUT', 'max_shots_per_clip là bắt buộc khi tính theo clip');
  }
  const lines = projects.map((project): ProjectLine => {
    const excluded = nonZero({
      below_min_duration: project.belowMinDuration,
      unknown_duration: project.unknownDuration,
      spec_fail: project.specFail,
    });
    const quantity =
      terms.unit === 'clip'
        ? Math.ceil(project.shots / (terms.maxShotsPerClip as number))
        : project.shots;
    const parts: string[] = [];
    if (project.belowMinDuration > 0) {
      parts.push(`${project.belowMinDuration} shot dưới ${terms.minShotSeconds} giây`);
    }
    if (project.unknownDuration > 0) {
      parts.push(`${project.unknownDuration} shot chưa có thời lượng`);
    }
    if (project.specFail > 0) {
      parts.push(`${project.specFail} shot không đạt kỹ thuật, duyệt không có lý do`);
    }
    return {
      projectId: project.projectId,
      counted: quantity > 0,
      quantity,
      reason: quantity > 0 ? null : 'no_qualifying_shot',
      message: parts.length > 0 ? `Bị loại: ${parts.join(', ')}` : null,
      excluded,
    };
  });
  return finish(terms.unitPrice, lines, []);
}

// ---------------------------------------------------------------------------
// per_source (Lái xe, Flycam)
// ---------------------------------------------------------------------------

export type PerSourceTerms = {
  pricePerSource: number;
  /** 300 s (5 phút) in D7. */
  minSourceSeconds: number;
};

export type PerSourceProjectFacts = {
  projectId: string;
  /** Approved videos of at least `minSourceSeconds`. */
  sources: number;
  /** Approved but shorter. */
  belowMinDuration: number;
  unknownDuration: number;
};

/** Reference counts for BR-16 (the services do it in SQL). */
export function countPerSource(
  projectId: string,
  durationsSeconds: ReadonlyArray<number | null>,
  minSourceSeconds: number,
): PerSourceProjectFacts {
  const facts = { projectId, sources: 0, belowMinDuration: 0, unknownDuration: 0 };
  for (const seconds of durationsSeconds) {
    if (seconds === null) {
      facts.unknownDuration += 1;
    } else if (seconds < minSourceSeconds) {
      facts.belowMinDuration += 1;
    } else {
      facts.sources += 1;
    }
  }
  return facts;
}

function durationLabel(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} phút` : `${seconds} giây`;
}

/** BR-16: quantity = approved videos ≥ `minSourceSeconds`; no tier, no extra scene. */
export function computePerSource(
  terms: PerSourceTerms,
  projects: readonly PerSourceProjectFacts[],
): PerProjectResult {
  requirePrice(terms.pricePerSource);
  const lines = projects.map((project): ProjectLine => {
    const parts: string[] = [];
    if (project.belowMinDuration > 0) {
      parts.push(`${project.belowMinDuration} file dưới ${durationLabel(terms.minSourceSeconds)}`);
    }
    if (project.unknownDuration > 0) {
      parts.push(`${project.unknownDuration} file chưa có thời lượng`);
    }
    return {
      projectId: project.projectId,
      counted: project.sources > 0,
      quantity: project.sources,
      reason: project.sources > 0 ? null : 'no_qualifying_source',
      message: parts.length > 0 ? `Bị loại: ${parts.join(', ')}` : null,
      excluded: nonZero({
        below_min_duration: project.belowMinDuration,
        unknown_duration: project.unknownDuration,
      }),
    };
  });
  return finish(terms.pricePerSource, lines, []);
}
