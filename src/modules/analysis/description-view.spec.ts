import type { DescriptionView } from './description-view';
import { descriptionView } from './description-view';

describe('descriptionView()', () => {
  describe('full description', () => {
    const stored: Record<string, unknown> = {
      title_vi: 'Hồ Gươm buổi sáng',
      summary_vi: 'Cảnh quay hồ Gươm lúc bình minh',
      summary_en: 'Shot of Hoan Kiem Lake at dawn',
      genre: 'phong cảnh',
      topics: ['hồ', 'bình minh'],
      subjects: ['mặt nước', 'cây cầu'],
      places: ['Hà Nội'],
      actions: ['tĩnh'],
      keywords_vi: ['hồ Gươm', 'bình minh'],
      tags: ['landscape', 'lake'],
      mood: 'yên bình',
      setting: 'outdoor',
      time_of_day: 'day',
      people_count: 'none',
      shot_variety: ['wide', 'extreme_wide'],
      camera_motions: ['static'],
      visible_text: '',
      has_watermark: false,
      usable: true,
      usable_reason: '',
      quality: 4,
    };

    let view: DescriptionView;
    beforeAll(() => {
      view = descriptionView(stored);
    });

    it('maps title_vi → titleVi', () => {
      expect(view.titleVi).toBe('Hồ Gươm buổi sáng');
    });

    it('maps summary_vi → summaryVi', () => {
      expect(view.summaryVi).toBe('Cảnh quay hồ Gươm lúc bình minh');
    });

    it('maps summary_en → summaryEn', () => {
      expect(view.summaryEn).toBe('Shot of Hoan Kiem Lake at dawn');
    });

    it('maps genre → genre', () => {
      expect(view.genre).toBe('phong cảnh');
    });

    it('maps topics → topics', () => {
      expect(view.topics).toEqual(['hồ', 'bình minh']);
    });

    it('maps subjects → subjects', () => {
      expect(view.subjects).toEqual(['mặt nước', 'cây cầu']);
    });

    it('maps places → places', () => {
      expect(view.places).toEqual(['Hà Nội']);
    });

    it('maps actions → actions', () => {
      expect(view.actions).toEqual(['tĩnh']);
    });

    it('maps keywords_vi → keywordsVi', () => {
      expect(view.keywordsVi).toEqual(['hồ Gươm', 'bình minh']);
    });

    it('maps tags → tags', () => {
      expect(view.tags).toEqual(['landscape', 'lake']);
    });

    it('maps mood → mood', () => {
      expect(view.mood).toBe('yên bình');
    });

    it('maps setting → setting', () => {
      expect(view.setting).toBe('outdoor');
    });

    it('maps time_of_day → timeOfDay', () => {
      expect(view.timeOfDay).toBe('day');
    });

    it('maps people_count → peopleCount', () => {
      expect(view.peopleCount).toBe('none');
    });

    it('maps shot_variety → shotVariety', () => {
      expect(view.shotVariety).toEqual(['wide', 'extreme_wide']);
    });

    it('maps camera_motions → cameraMotions', () => {
      expect(view.cameraMotions).toEqual(['static']);
    });

    it('maps visible_text → visibleText', () => {
      expect(view.visibleText).toBe('');
    });

    it('maps has_watermark → hasWatermark', () => {
      expect(view.hasWatermark).toBe(false);
    });

    it('maps usable → usable', () => {
      expect(view.usable).toBe(true);
    });

    it('maps usable_reason → usableReason', () => {
      expect(view.usableReason).toBe('');
    });

    it('maps quality → quality', () => {
      expect(view.quality).toBe(4);
    });
  });

  describe('missing / empty fields → safe defaults', () => {
    it('returns empty strings for missing text fields', () => {
      const view = descriptionView({});
      expect(view.titleVi).toBe('');
      expect(view.summaryVi).toBe('');
      expect(view.summaryEn).toBe('');
      expect(view.genre).toBe('');
      expect(view.mood).toBe('');
      expect(view.visibleText).toBe('');
      expect(view.usableReason).toBe('');
    });

    it('returns empty arrays for missing list fields', () => {
      const view = descriptionView({});
      expect(view.topics).toEqual([]);
      expect(view.subjects).toEqual([]);
      expect(view.places).toEqual([]);
      expect(view.actions).toEqual([]);
      expect(view.keywordsVi).toEqual([]);
      expect(view.tags).toEqual([]);
      expect(view.shotVariety).toEqual([]);
      expect(view.cameraMotions).toEqual([]);
    });

    it('returns "unknown" for missing setting', () => {
      const view = descriptionView({});
      expect(view.setting).toBe('unknown');
    });

    it('returns "unknown" for missing time_of_day', () => {
      const view = descriptionView({});
      expect(view.timeOfDay).toBe('unknown');
    });

    it('returns "none" for missing people_count', () => {
      const view = descriptionView({});
      expect(view.peopleCount).toBe('none');
    });

    it('returns false for missing has_watermark', () => {
      const view = descriptionView({});
      expect(view.hasWatermark).toBe(false);
    });

    it('returns false for missing usable', () => {
      const view = descriptionView({});
      expect(view.usable).toBe(false);
    });

    it('returns 0 for missing quality', () => {
      const view = descriptionView({});
      expect(view.quality).toBe(0);
    });
  });

  describe('non-string / non-array values → safe defaults', () => {
    it('ignores non-string title_vi and returns empty string', () => {
      const view = descriptionView({ title_vi: 42 });
      expect(view.titleVi).toBe('');
    });

    it('ignores non-array tags and returns empty array', () => {
      const view = descriptionView({ tags: 'not-an-array' });
      expect(view.tags).toEqual([]);
    });

    it('filters non-string values out of list fields', () => {
      const view = descriptionView({ topics: ['valid', 42, null, 'also valid'] });
      expect(view.topics).toEqual(['valid', 'also valid']);
    });

    it('coerces non-number quality to 0', () => {
      const view = descriptionView({ quality: 'high' });
      expect(view.quality).toBe(0);
    });

    it('treats non-boolean has_watermark !== true as false', () => {
      expect(descriptionView({ has_watermark: 1 }).hasWatermark).toBe(false);
      expect(descriptionView({ has_watermark: 'yes' }).hasWatermark).toBe(false);
      expect(descriptionView({ has_watermark: true }).hasWatermark).toBe(true);
    });

    it('treats non-boolean usable !== true as false', () => {
      expect(descriptionView({ usable: 1 }).usable).toBe(false);
      expect(descriptionView({ usable: true }).usable).toBe(true);
    });
  });
});
