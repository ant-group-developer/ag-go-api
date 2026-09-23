import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSettingEntity } from '../../database/entities/system-setting.entity';
import { UpdateSettingsDto } from './dto/update-settings.dto';

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(SystemSettingEntity)
    private readonly repository: Repository<SystemSettingEntity>,
  ) {}

  async getPublic() {
    const setting = await this.repository.findOne({ where: { key: 'web' } });
    return setting?.value ?? { siteName: 'AG Go' };
  }

  async get() {
    const setting = await this.repository.findOne({ where: { key: 'web' } });
    return setting?.value ?? { siteName: 'AG Go' };
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
    return setting.value;
  }
}
