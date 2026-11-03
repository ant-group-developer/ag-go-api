import { TECH_SPEC_PRESETS } from '../contracts/contract-terms';
import {
  checkMedia,
  mediaFacts,
  resolveCheckRules,
  specHash,
  summarizeProject,
  worstLevel,
  type CheckRules,
  type MediaFacts,
  type ProjectMediaForSummary,
  type SpecFinding,
  type TermsForChecks,
} from './spec-check';

const footage = TECH_SPEC_PRESETS.footage_4k60.techSpec as Record<string, unknown>;

function terms(overrides: Partial<TermsForChecks> = {}): TermsForChecks {
  return {
    pricing_model: 'package_tier',
    pricing_config: {},
    tech_spec: footage,
    ...overrides,
  };
}

/** A good 4K60 video of 25 s with sound. */
function facts(overrides: Partial<MediaFacts> = {}): MediaFacts {
  return {
    analysisId: 'analysis-1',
    pendingAnalysisStatus: null,
    width: 3840,
    height: 2160,
    fps: 59.94,
    durationMs: 25_000,
    hasAudio: true,
    usable: true,
    usableReason: null,
    quality: 4,
    dead: false,
    deadReason: null,
    ...overrides,
  };
}

function finding(findings: SpecFinding[], rule: SpecFinding['rule']): SpecFinding | undefined {
  return findings.find((item) => item.rule === rule);
}

function rulesOf(techSpec: Record<string, unknown>, overrides: Partial<TermsForChecks> = {}) {
  return resolveCheckRules(terms({ tech_spec: techSpec, ...overrides }));
}

describe('worstLevel', () => {
  it('ranks fail > unknown > warn > pass', () => {
    expect(worstLevel([])).toBe('pass');
    expect(worstLevel(['pass', 'warn'])).toBe('warn');
    expect(worstLevel(['warn', 'unknown', 'pass'])).toBe('unknown');
    expect(worstLevel(['unknown', 'fail', 'warn'])).toBe('fail');
  });
});

describe('resolveCheckRules', () => {
  it('reads the Footage 4K60 preset', () => {
    expect(resolveCheckRules(terms())).toEqual({
      minWidth: 3840,
      minHeight: 2160,
      fps: { target: 60, tolerance: 0.1 },
      minShotSeconds: null,
      sourceMinSeconds: 10,
      sourcePreferredSeconds: 20,
      sourcePreferredRatio: 0.8,
      requireAudio: false,
      rejectDead: true,
      minQuality: null,
      minShotsPerScene: 5,
      minTopicMinutes: null,
      maxTopicMinutes: null,
      uniformWithinProject: true,
    });
  });

  it('takes per_unit min_shot_seconds from the pricing config when the tech spec has none', () => {
    const rules = resolveCheckRules(
      terms({
        pricing_model: 'per_unit',
        pricing_config: { unit: 'shot', unit_price: 300000, min_shot_seconds: 60 },
        tech_spec: { min_width: 3840, min_height: 2160 },
      }),
    );
    expect(rules.minShotSeconds).toBe(60);
  });

  it('prefers the tech spec over the pricing config', () => {
    const rules = resolveCheckRules(
      terms({
        pricing_model: 'per_unit',
        pricing_config: { unit: 'shot', unit_price: 300000, min_shot_seconds: 60 },
        tech_spec: { min_shot_seconds: 30 },
      }),
    );
    expect(rules.minShotSeconds).toBe(30);
  });

  it('ignores min_shot_seconds of the pricing config for other models', () => {
    const rules = resolveCheckRules(
      terms({ pricing_config: { min_shot_seconds: 60 }, tech_spec: {} }),
    );
    expect(rules.minShotSeconds).toBeNull();
  });

  it('takes per_topic minutes and audio from the pricing config', () => {
    const rules = resolveCheckRules(
      terms({
        pricing_model: 'per_topic',
        pricing_config: {
          unit_price: 2500000,
          min_topic_minutes: 20,
          max_topic_minutes: 60,
          require_audio: true,
        },
        tech_spec: {},
      }),
    );
    expect(rules).toMatchObject({ minTopicMinutes: 20, maxTopicMinutes: 60, requireAudio: true });
  });

  it('keeps an explicit require_audio of the tech spec over per_topic', () => {
    const rules = resolveCheckRules(
      terms({
        pricing_model: 'per_topic',
        pricing_config: { unit_price: 1, min_topic_minutes: 20, require_audio: true },
        tech_spec: { require_audio: false },
      }),
    );
    expect(rules.requireAudio).toBe(false);
  });

  it('defaults: no rule, dead videos rejected, audio warned', () => {
    expect(resolveCheckRules(terms({ tech_spec: {} }))).toEqual({
      minWidth: null,
      minHeight: null,
      fps: null,
      minShotSeconds: null,
      sourceMinSeconds: null,
      sourcePreferredSeconds: null,
      sourcePreferredRatio: null,
      requireAudio: undefined,
      rejectDead: true,
      minQuality: null,
      minShotsPerScene: null,
      minTopicMinutes: null,
      maxTopicMinutes: null,
      uniformWithinProject: false,
    });
  });

  it('reads a tech spec that no longer parses field by field', () => {
    const rules = resolveCheckRules(terms({ tech_spec: { min_width: 1920, legacy_field: 1 } }));
    expect(rules.minWidth).toBe(1920);
  });

  it('treats null rules as absent', () => {
    const rules = resolveCheckRules(
      terms({ tech_spec: { min_width: null, fps: null, min_quality: null } }),
    );
    expect(rules).toMatchObject({ minWidth: null, fps: null, minQuality: null });
  });
});

describe('specHash', () => {
  it('is stable for the same rules whatever the key order', () => {
    const left = resolveCheckRules(terms({ tech_spec: { min_width: 1920, min_height: 1080 } }));
    const right = resolveCheckRules(terms({ tech_spec: { min_height: 1080, min_width: 1920 } }));
    expect(specHash(left)).toBe(specHash(right));
    expect(specHash(left)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a rule changes', () => {
    const before = resolveCheckRules(terms());
    const after = resolveCheckRules(terms({ tech_spec: { ...footage, min_width: 1920 } }));
    expect(specHash(before)).not.toBe(specHash(after));
  });

  it('changes with model terms the tech spec does not repeat', () => {
    const base = { unit: 'shot', unit_price: 1 };
    const short = resolveCheckRules(
      terms({ pricing_model: 'per_unit', pricing_config: { ...base, min_shot_seconds: 30 } }),
    );
    const long = resolveCheckRules(
      terms({ pricing_model: 'per_unit', pricing_config: { ...base, min_shot_seconds: 60 } }),
    );
    expect(specHash(short)).not.toBe(specHash(long));
  });
});

describe('checkMedia', () => {
  const footageRules = resolveCheckRules(terms());

  it('passes a good 4K60 video, with every rule listed', () => {
    const check = checkMedia(footageRules, facts());
    expect(check.result).toBe('pass');
    expect(check.findings.map((item) => item.rule)).toEqual([
      'resolution',
      'fps',
      'source_min_seconds',
      'dead',
    ]);
    expect(check.findings.every((item) => item.level === 'pass')).toBe(true);
  });

  it('is unknown without an analysis, saying whether one is running', () => {
    const missing = checkMedia(footageRules, facts({ analysisId: null }));
    expect(missing).toEqual({
      result: 'unknown',
      findings: [
        expect.objectContaining({ rule: 'analysis', level: 'unknown', actual: 'missing' }),
      ],
    });
    const running = checkMedia(
      footageRules,
      facts({ analysisId: null, pendingAnalysisStatus: 'extracting' }),
    );
    expect(running.findings[0]).toMatchObject({ actual: 'extracting' });
    expect(running.findings[0].message).toContain('extracting');
  });

  describe('resolution', () => {
    it('fails a 1080p video against 4K', () => {
      const check = checkMedia(footageRules, facts({ width: 1920, height: 1080 }));
      expect(check.result).toBe('fail');
      expect(finding(check.findings, 'resolution')).toMatchObject({
        level: 'fail',
        actual: '1920x1080',
        expected: { min_width: 3840, min_height: 2160 },
      });
    });

    it('accepts a portrait 4K video (long side vs long side)', () => {
      const check = checkMedia(footageRules, facts({ width: 2160, height: 3840 }));
      expect(finding(check.findings, 'resolution')?.level).toBe('pass');
    });

    it('fails when only the short side is too small', () => {
      const check = checkMedia(footageRules, facts({ width: 3840, height: 1600 }));
      expect(finding(check.findings, 'resolution')?.level).toBe('fail');
    });

    it('accepts larger than required (DCI 4K, 6K)', () => {
      expect(
        finding(
          checkMedia(footageRules, facts({ width: 4096, height: 2160 })).findings,
          'resolution',
        )?.level,
      ).toBe('pass');
      expect(
        finding(
          checkMedia(footageRules, facts({ width: 6144, height: 3456 })).findings,
          'resolution',
        )?.level,
      ).toBe('pass');
    });

    it('checks the long side only with min_width alone', () => {
      const rules = rulesOf({ min_width: 1920 });
      expect(
        finding(checkMedia(rules, facts({ width: 1080, height: 1920 })).findings, 'resolution')
          ?.level,
      ).toBe('pass');
      expect(
        finding(checkMedia(rules, facts({ width: 1280, height: 720 })).findings, 'resolution')
          ?.level,
      ).toBe('fail');
    });

    it('checks the short side only with min_height alone', () => {
      const rules = rulesOf({ min_height: 1080 });
      expect(
        finding(checkMedia(rules, facts({ width: 1080, height: 1920 })).findings, 'resolution')
          ?.level,
      ).toBe('pass');
      expect(
        finding(checkMedia(rules, facts({ width: 1920, height: 1000 })).findings, 'resolution')
          ?.level,
      ).toBe('fail');
    });

    it('is unknown when the size could not be read', () => {
      const check = checkMedia(footageRules, facts({ width: null }));
      expect(finding(check.findings, 'resolution')?.level).toBe('unknown');
      expect(check.result).toBe('unknown');
    });

    it('is not checked when the contract sets no size', () => {
      const check = checkMedia(rulesOf({}), facts({ width: 640, height: 360 }));
      expect(finding(check.findings, 'resolution')).toBeUndefined();
    });
  });

  describe('fps', () => {
    it.each([
      [60, 'pass'],
      [59.94, 'pass'],
      [60.1, 'pass'],
      [59.9, 'pass'],
      [59.8, 'fail'],
      [50, 'fail'],
      [29.97, 'fail'],
      [120, 'fail'],
    ])('%s fps against 60 ± 0.1 → %s', (fps, level) => {
      const check = checkMedia(footageRules, facts({ fps }));
      expect(finding(check.findings, 'fps')).toMatchObject({
        level,
        actual: fps,
        expected: { target: 60, tolerance: 0.1 },
      });
    });

    it('is unknown when the fps could not be read', () => {
      expect(finding(checkMedia(footageRules, facts({ fps: null })).findings, 'fps')?.level).toBe(
        'unknown',
      );
    });

    it('uses a zero tolerance when none is given', () => {
      const rules = rulesOf({ fps: { target: 25, tolerance: 0 } });
      expect(finding(checkMedia(rules, facts({ fps: 25 })).findings, 'fps')?.level).toBe('pass');
      expect(finding(checkMedia(rules, facts({ fps: 25.01 })).findings, 'fps')?.level).toBe('fail');
    });
  });

  describe('durations', () => {
    const shotRules = resolveCheckRules(
      terms({
        pricing_model: 'per_unit',
        pricing_config: { unit: 'shot', unit_price: 300000, min_shot_seconds: 60 },
        tech_spec: {},
      }),
    );

    it('fails a per_unit shot shorter than min_shot_seconds', () => {
      const check = checkMedia(shotRules, facts({ durationMs: 59_900 }));
      expect(check.result).toBe('fail');
      expect(finding(check.findings, 'min_shot_seconds')).toMatchObject({
        level: 'fail',
        expected: 60,
        actual: 59.9,
      });
    });

    it('passes a shot of exactly min_shot_seconds', () => {
      expect(
        finding(checkMedia(shotRules, facts({ durationMs: 60_000 })).findings, 'min_shot_seconds')
          ?.level,
      ).toBe('pass');
    });

    it('only warns a package source under 10 s: it is not counted, not failed (BR-17)', () => {
      const check = checkMedia(footageRules, facts({ durationMs: 9_999 }));
      expect(check.result).toBe('warn');
      expect(finding(check.findings, 'source_min_seconds')).toMatchObject({
        level: 'warn',
        expected: 10,
        actual: 10,
      });
      expect(finding(check.findings, 'source_min_seconds')?.message).toContain('không được tính');
    });

    it('counts a source of exactly 10 s', () => {
      expect(
        finding(
          checkMedia(footageRules, facts({ durationMs: 10_000 })).findings,
          'source_min_seconds',
        )?.level,
      ).toBe('pass');
    });

    it('is unknown without a duration', () => {
      expect(
        finding(checkMedia(shotRules, facts({ durationMs: null })).findings, 'min_shot_seconds')
          ?.level,
      ).toBe('unknown');
    });
  });

  describe('audio', () => {
    it('fails a silent video when the contract requires audio', () => {
      const rules = rulesOf({ require_audio: true });
      const check = checkMedia(rules, facts({ hasAudio: false }));
      expect(check.result).toBe('fail');
      expect(finding(check.findings, 'audio')).toMatchObject({ level: 'fail', actual: false });
    });

    it('passes a video with audio when required', () => {
      const rules = rulesOf({ require_audio: true });
      expect(finding(checkMedia(rules, facts()).findings, 'audio')?.level).toBe('pass');
    });

    it('is unknown when required and not known', () => {
      const rules = rulesOf({ require_audio: true });
      expect(finding(checkMedia(rules, facts({ hasAudio: null })).findings, 'audio')?.level).toBe(
        'unknown',
      );
    });

    it('only warns a silent video when the contract says nothing', () => {
      const check = checkMedia(rulesOf({}), facts({ hasAudio: false }));
      expect(check.result).toBe('warn');
      expect(finding(check.findings, 'audio')?.level).toBe('warn');
    });

    it('does not list audio when the contract says nothing and there is sound', () => {
      expect(finding(checkMedia(rulesOf({}), facts()).findings, 'audio')).toBeUndefined();
    });

    it('does not check audio when the contract turns it off (footage)', () => {
      expect(
        finding(checkMedia(footageRules, facts({ hasAudio: false })).findings, 'audio'),
      ).toBeUndefined();
    });

    it('requires audio of a per_topic contract by default (D1)', () => {
      const rules = resolveCheckRules(
        terms({
          pricing_model: 'per_topic',
          pricing_config: { unit_price: 1, min_topic_minutes: 20, require_audio: true },
          tech_spec: {},
        }),
      );
      expect(checkMedia(rules, facts({ hasAudio: false })).result).toBe('fail');
    });
  });

  describe('dead and usable', () => {
    it.each([
      ['black', 'màn hình đen'],
      ['frozen', 'đứng hình'],
      ['blurry', 'mờ'],
    ])('fails a %s video from the farm scan', (deadReason, label) => {
      const check = checkMedia(
        footageRules,
        facts({ dead: true, deadReason, usable: false, quality: 0 }),
      );
      expect(check.result).toBe('fail');
      const dead = finding(check.findings, 'dead');
      expect(dead).toMatchObject({ level: 'fail', actual: deadReason });
      expect(dead?.message).toContain(label);
      // Dead videos are not described: no separate usable finding.
      expect(finding(check.findings, 'usable')).toBeUndefined();
    });

    it('fails a video the AI found unusable, with its reason', () => {
      const check = checkMedia(
        footageRules,
        facts({ usable: false, usableReason: 'Có watermark kênh khác' }),
      );
      expect(check.result).toBe('fail');
      expect(finding(check.findings, 'usable')?.message).toContain('Có watermark kênh khác');
    });

    it('does not check dead / usable when the contract keeps dead videos', () => {
      const rules = rulesOf({ reject_dead: false });
      const check = checkMedia(rules, facts({ dead: true, deadReason: 'black', usable: false }));
      expect(check.result).toBe('pass');
      expect(check.findings).toEqual([]);
    });
  });

  describe('quality', () => {
    const rules = rulesOf({ min_quality: 0.6 });

    it('warns under the threshold (score / 5)', () => {
      const check = checkMedia(rules, facts({ quality: 2 }));
      expect(check.result).toBe('warn');
      expect(finding(check.findings, 'quality')).toMatchObject({
        level: 'warn',
        expected: 0.6,
        actual: 2,
      });
    });

    it('passes at the threshold', () => {
      expect(finding(checkMedia(rules, facts({ quality: 3 })).findings, 'quality')?.level).toBe(
        'pass',
      );
    });

    it('is unknown without a score', () => {
      expect(finding(checkMedia(rules, facts({ quality: null })).findings, 'quality')?.level).toBe(
        'unknown',
      );
    });

    it('is not checked for a dead video (already failed)', () => {
      const check = checkMedia(rules, facts({ dead: true, deadReason: 'frozen', quality: 0 }));
      expect(finding(check.findings, 'quality')).toBeUndefined();
    });
  });

  it('keeps the worst level and every finding', () => {
    const check = checkMedia(
      footageRules,
      facts({ width: 1920, height: 1080, fps: null, durationMs: 5_000 }),
    );
    expect(check.result).toBe('fail');
    expect(check.findings.map((item) => [item.rule, item.level])).toEqual([
      ['resolution', 'fail'],
      ['fps', 'unknown'],
      ['source_min_seconds', 'warn'],
      ['dead', 'pass'],
    ]);
  });
});

describe('summarizeProject', () => {
  const footageRules = resolveCheckRules(terms());

  function item(
    evaluationStatus: ProjectMediaForSummary['evaluationStatus'],
    overrides: Partial<MediaFacts> = {},
    rules: CheckRules = footageRules,
  ): ProjectMediaForSummary {
    const itemFacts = facts(overrides);
    return { evaluationStatus, facts: itemFacts, result: checkMedia(rules, itemFacts).result };
  }

  function many(count: number, make: () => ProjectMediaForSummary) {
    return Array.from({ length: count }, make);
  }

  it('passes 5 approved good shots of one format', () => {
    const summary = summarizeProject(
      footageRules,
      many(5, () => item('approved')),
    );
    expect(summary.result).toBe('pass');
    expect(summary.counts).toEqual({ total: 5, pass: 5, warn: 0, fail: 0, unknown: 0 });
    expect(summary.approvedVideos).toBe(5);
    expect(summary.approvedDurationMs).toBe(125_000);
    expect(summary.findings.map((entry) => entry.rule)).toEqual([
      'media',
      'min_shots_per_scene',
      'source_duration_ratio',
      'uniform_within_project',
    ]);
  });

  it('rolls up the worst video result, leaving rejected videos out', () => {
    const summary = summarizeProject(footageRules, [
      ...many(5, () => item('approved')),
      item('rejected', { width: 1280, height: 720 }),
    ]);
    expect(summary.rejected).toBe(1);
    expect(summary.counts.fail).toBe(0);
    expect(finding(summary.findings, 'media')?.level).toBe('pass');

    const failing = summarizeProject(footageRules, [
      ...many(5, () => item('approved')),
      item('pending', { width: 1280, height: 720 }),
    ]);
    expect(finding(failing.findings, 'media')?.level).toBe('fail');
    expect(failing.result).toBe('fail');
  });

  describe('shots per scene', () => {
    it('warns with too few approved shots once nothing is pending', () => {
      const summary = summarizeProject(footageRules, [
        ...many(4, () => item('approved')),
        item('rejected'),
      ]);
      expect(finding(summary.findings, 'min_shots_per_scene')).toMatchObject({
        level: 'warn',
        expected: 5,
        actual: { approved: 4, pending: 0 },
      });
      expect(summary.result).toBe('warn');
    });

    it('is unknown while media still wait for evaluation', () => {
      const summary = summarizeProject(footageRules, [
        ...many(3, () => item('approved')),
        ...many(4, () => item('pending')),
      ]);
      expect(finding(summary.findings, 'min_shots_per_scene')?.level).toBe('unknown');
    });
  });

  describe('topic minutes (per_topic, BR-10)', () => {
    const topicRules = resolveCheckRules(
      terms({
        pricing_model: 'per_topic',
        pricing_config: {
          unit_price: 2500000,
          min_topic_minutes: 20,
          max_topic_minutes: 60,
          require_audio: true,
        },
        tech_spec: {},
      }),
    );
    const minutes = (value: number) => ({ durationMs: value * 60_000 });

    it('passes 20 minutes of approved video', () => {
      const summary = summarizeProject(topicRules, [
        item('approved', minutes(12), topicRules),
        item('approved', minutes(8), topicRules),
        item('rejected', minutes(30), topicRules),
      ]);
      expect(finding(summary.findings, 'min_topic_minutes')).toMatchObject({
        level: 'pass',
        actual: 20,
      });
      expect(summary.result).toBe('pass');
    });

    it('fails under 20 minutes once evaluated: the topic is not paid', () => {
      const summary = summarizeProject(topicRules, [
        item('approved', minutes(15), topicRules),
        item('rejected', minutes(10), topicRules),
      ]);
      expect(finding(summary.findings, 'min_topic_minutes')).toMatchObject({
        level: 'fail',
        actual: 15,
      });
      expect(summary.result).toBe('fail');
    });

    it('is unknown under 20 minutes while media are pending', () => {
      const summary = summarizeProject(topicRules, [
        item('approved', minutes(15), topicRules),
        item('pending', minutes(10), topicRules),
      ]);
      expect(finding(summary.findings, 'min_topic_minutes')?.level).toBe('unknown');
    });

    it('is unknown when an approved video has no known duration', () => {
      const summary = summarizeProject(topicRules, [
        item('approved', minutes(15), topicRules),
        item('approved', { durationMs: null }, topicRules),
      ]);
      expect(finding(summary.findings, 'min_topic_minutes')?.level).toBe('unknown');
    });

    it('warns over max_topic_minutes', () => {
      const summary = summarizeProject(topicRules, [item('approved', minutes(61), topicRules)]);
      expect(finding(summary.findings, 'max_topic_minutes')).toMatchObject({
        level: 'warn',
        actual: 61,
      });
    });
  });

  describe('80/20 duration ratio', () => {
    it('warns when under 80% of sources reach 20 s', () => {
      const summary = summarizeProject(footageRules, [
        ...many(3, () => item('approved', { durationMs: 25_000 })),
        ...many(2, () => item('approved', { durationMs: 12_000 })),
        // Under 10 s: not a source, left out of the ratio.
        item('approved', { durationMs: 5_000 }),
      ]);
      expect(finding(summary.findings, 'source_duration_ratio')).toMatchObject({
        level: 'warn',
        actual: { sources: 5, long: 3, ratio: 0.6 },
      });
    });

    it('passes at exactly 80%', () => {
      const summary = summarizeProject(footageRules, [
        ...many(4, () => item('approved', { durationMs: 20_000 })),
        item('approved', { durationMs: 10_000 }),
      ]);
      expect(finding(summary.findings, 'source_duration_ratio')?.level).toBe('pass');
    });

    it('is left out without approved sources', () => {
      const summary = summarizeProject(
        footageRules,
        many(5, () => item('pending')),
      );
      expect(finding(summary.findings, 'source_duration_ratio')).toBeUndefined();
    });
  });

  describe('uniform within project', () => {
    it('warns on mixed resolution or fps, biggest group first', () => {
      const summary = summarizeProject(footageRules, [
        ...many(3, () => item('approved')),
        item('approved', { fps: 30 }),
        item('approved', { width: 2160, height: 3840 }),
      ]);
      const uniform = finding(summary.findings, 'uniform_within_project');
      expect(uniform?.level).toBe('warn');
      // Portrait and landscape 4K at the same fps are the same format.
      expect(uniform?.actual).toEqual([
        { format: '3840x2160@59.94', count: 4 },
        { format: '3840x2160@30', count: 1 },
      ]);
    });

    it('ignores videos without analysis and rejected ones', () => {
      const summary = summarizeProject(footageRules, [
        ...many(5, () => item('approved')),
        item('rejected', { fps: 25 }),
        item('pending', { analysisId: null, fps: null }),
      ]);
      expect(finding(summary.findings, 'uniform_within_project')?.level).toBe('pass');
      expect(finding(summary.findings, 'media')?.level).toBe('unknown');
    });

    it('is not checked when the contract does not ask for it', () => {
      const rules = rulesOf({ uniform_within_project: false });
      const summary = summarizeProject(rules, [
        item('approved', {}, rules),
        item('approved', { fps: 30 }, rules),
      ]);
      expect(finding(summary.findings, 'uniform_within_project')).toBeUndefined();
    });
  });

  it('has no finding (pass) for a project without videos and no project rule', () => {
    const summary = summarizeProject(rulesOf({}), []);
    expect(summary).toMatchObject({ result: 'pass', findings: [], counts: { total: 0 } });
  });
});

describe('mediaFacts', () => {
  const row = {
    analysisId: 'analysis-1',
    pendingAnalysisStatus: null,
    durationMs: 25_000,
    hasAudio: false,
    usable: true,
    quality: 4,
    technical: { dead: false, dead_reason: null, black_ratio: 0 },
    media: { width: 3840, height: 2160, fps: 59.94, has_audio: false },
    usableReason: '  ',
    sourceMetadata: { width: 1920, height: 1080 },
  };

  it('reads size and fps from the extract manifest media', () => {
    expect(mediaFacts(row)).toEqual(facts({ hasAudio: false, usableReason: null }));
  });

  it('falls back to the asset size, without fps', () => {
    const result = mediaFacts({
      ...row,
      media: null,
      sourceMetadata: { width: '1920', height: 1080 },
    });
    expect(result).toMatchObject({ width: 1920, height: 1080, fps: null });
  });

  it('reads dead and its reason from the technical metrics', () => {
    const result = mediaFacts({
      ...row,
      usable: false,
      quality: 0,
      technical: { dead: true, dead_reason: 'frozen' },
    });
    expect(result).toMatchObject({ dead: true, deadReason: 'frozen', usable: false, quality: 0 });
  });

  it('keeps the running status only without a current analysis', () => {
    expect(
      mediaFacts({ ...row, pendingAnalysisStatus: 'queued' }).pendingAnalysisStatus,
    ).toBeNull();
    expect(
      mediaFacts({ ...row, analysisId: null, pendingAnalysisStatus: 'queued' })
        .pendingAnalysisStatus,
    ).toBe('queued');
  });

  it('ignores invalid numbers', () => {
    const result = mediaFacts({
      ...row,
      durationMs: -1,
      quality: null,
      media: { width: 0, height: 'x', fps: Number.NaN },
      sourceMetadata: null,
    });
    expect(result).toMatchObject({ width: null, height: null, fps: null, durationMs: null });
  });
});
