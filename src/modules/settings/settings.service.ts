import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSettingEntity } from '../../database/entities/system-setting.entity';
import { UpdateSettingsDto } from './dto/update-settings.dto';

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(SystemSettingEntity)
    private readonly repository: Repository<SystemSettingEntity>,
    private readonly config: ConfigService,
  ) {}

  private readonly defaultWebSettings = {
    siteName: 'AG Go',
    siteDescription: 'AG Go internal media workspace',
    logoUrl: null,
    faviconUrl: null,
    loginBackgroundUrl: null,
    supportEmail: null,
    supportUrl: null,
    primaryColor: null,
  };

  async getPublic() {
    const setting = await this.repository.findOne({ where: { key: 'web' } });
    return this.withDefaults(setting?.value);
  }

  async get() {
    const setting = await this.repository.findOne({ where: { key: 'web' } });
    return this.withDefaults(setting?.value);
  }

  /** Largest file a user may upload, in bytes. */
  async getMaxUploadSizeBytes(): Promise<number> {
    return (await this.get()).maxUploadSizeBytes;
  }

  async update(dto: UpdateSettingsDto, userId: string) {
    const current = await this.repository.findOne({ where: { key: 'web' } });
    const setting = await this.repository.save({
      ...(current ?? {}),
      key: 'web',
      value: {
        ...(current?.value ?? {}),
        ...dto,
      } as Record<string, unknown>,
      updatedBy: userId,
    });
    return this.withDefaults(setting.value);
  }

  private withDefaults(value: Record<string, unknown> | undefined) {
    const storedMaxUpload = value?.maxUploadSizeBytes;
    return {
      ...this.defaultWebSettings,
      ...(value ?? {}),
      // Unset (or cleared in the UI) falls back to the deployment default from the environment.
      maxUploadSizeBytes:
        typeof storedMaxUpload === 'number'
          ? storedMaxUpload
          : this.config.getOrThrow<number>('MAX_UPLOAD_SIZE_BYTES'),
    };
  }
}
