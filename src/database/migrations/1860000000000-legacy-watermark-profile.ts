import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Imports a legacy WATERMARK JSON supplied through LEGACY_WATERMARK_JSON.
 * The storage copy is intentionally external: set LEGACY_WATERMARK_LOGO_ASSET_ID
 * after copying the legacy logo into an asset owned by the v2 system.
 */
export class LegacyWatermarkProfileMigration1860000000000 implements MigrationInterface {
  name = 'LegacyWatermarkProfileMigration1860000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const raw = process.env.LEGACY_WATERMARK_JSON;
    const logoAssetId = process.env.LEGACY_WATERMARK_LOGO_ASSET_ID ?? null;
    if (!raw) {
      return;
    }

    let legacy: Record<string, unknown>;
    try {
      legacy = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error('LEGACY_WATERMARK_JSON must contain valid JSON');
    }

    const config = {
      text: typeof legacy.text === 'string' ? legacy.text.slice(0, 120) : 'AG Go Preview',
      logoAssetId,
      color: typeof legacy.color === 'string' ? legacy.color : '#FFFFFF',
      fontFamily: typeof legacy.font_family === 'string' ? legacy.font_family : 'Arial',
      fontSize: typeof legacy.font_size === 'number' ? legacy.font_size : 24,
      repeat: typeof legacy.repeat === 'boolean' ? legacy.repeat : true,
      gapX: typeof legacy.gap_x === 'number' ? legacy.gap_x : 220,
      gapY: typeof legacy.gap_y === 'number' ? legacy.gap_y : 100,
      rotate: typeof legacy.rotate === 'number' ? legacy.rotate : -20,
      maxWidth: typeof legacy.max_width === 'number' ? legacy.max_width : null,
      position: 'bottom-right',
      opacity: typeof legacy.opacity === 'number' ? legacy.opacity : 0.32,
      scale: 0.28,
      margin: 24,
    };

    await queryRunner.query(
      `UPDATE render_profiles
       SET watermark_enabled = true,
           watermark_config = $1::jsonb,
           updated_at = now()
       WHERE code = 'default'
         AND is_active = true`,
      [JSON.stringify(config)],
    );
  }

  async down(): Promise<void> {
    // Legacy data is preserved; reverting does not remove imported settings.
  }
}
