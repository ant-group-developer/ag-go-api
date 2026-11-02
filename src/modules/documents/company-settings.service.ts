import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSettingEntity } from '../../database/entities/system-setting.entity';
import type { UpdateCompanySettingsDto } from './dto/document.dto';
import type { CompanySnapshot } from './render-data';

export const COMPANY_SETTING_KEY = 'company';

/** Party A details printed on every document (FR-D-05). */
export const REQUIRED_COMPANY_FIELDS = [
  'name',
  'taxCode',
  'representative',
  'title',
  'address',
] as const satisfies ReadonlyArray<keyof CompanySnapshot>;

const COMPANY_FIELDS = [
  ...REQUIRED_COMPANY_FIELDS,
  'phone',
  'email',
  'bankAccountNumber',
  'bankName',
] as const satisfies ReadonlyArray<keyof CompanySnapshot>;

export type CompanySettings = Record<(typeof COMPANY_FIELDS)[number], string | null>;

export type CompanySettingsView = CompanySettings & {
  complete: boolean;
  missing: string[];
  updatedAt: Date | null;
  updatedBy: string | null;
};

function clean(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function missingCompanyFields(settings: Partial<CompanySettings>): string[] {
  return REQUIRED_COMPANY_FIELDS.filter((field) => !clean(settings[field]));
}

/**
 * Party A (tên công ty, MST, người đại diện, chức vụ, địa chỉ…) in `system_settings.company`. Issue
 * copies it into the document's `company_snapshot`, so changing the representative later leaves
 * issued documents as they were (FR-D-05).
 */
@Injectable()
export class CompanySettingsService {
  constructor(
    @InjectRepository(SystemSettingEntity)
    private readonly settings: Repository<SystemSettingEntity>,
  ) {}

  async get(): Promise<CompanySettingsView> {
    const row = await this.settings.findOne({ where: { key: COMPANY_SETTING_KEY } });
    return this.view(row);
  }

  async update(dto: UpdateCompanySettingsDto, userId: string): Promise<CompanySettingsView> {
    const current = await this.settings.findOne({ where: { key: COMPANY_SETTING_KEY } });
    const value: Record<string, unknown> = { ...(current?.value ?? {}) };
    for (const field of COMPANY_FIELDS) {
      if (dto[field] !== undefined) {
        value[field] = clean(dto[field]);
      }
    }
    const saved = await this.settings.save({
      ...(current ?? {}),
      key: COMPANY_SETTING_KEY,
      value,
      updatedBy: userId,
    });
    return this.view(saved);
  }

  /**
   * What is captured on an issued document; 422 COMPANY_PROFILE_INCOMPLETE (details.missing) when
   * a required field is not set (FR-D-03).
   */
  async snapshot(now = new Date()): Promise<CompanySnapshot> {
    const view = await this.get();
    if (!view.complete) {
      throw new UnprocessableEntityException({
        code: 'COMPANY_PROFILE_INCOMPLETE',
        message: 'Party A details are incomplete (Settings > company)',
        details: { missing: view.missing },
      });
    }
    return {
      name: view.name!,
      taxCode: view.taxCode!,
      representative: view.representative!,
      title: view.title!,
      address: view.address!,
      phone: view.phone,
      email: view.email,
      bankAccountNumber: view.bankAccountNumber,
      bankName: view.bankName,
      capturedAt: now.toISOString(),
    };
  }

  /** The current details as they are (preview of a draft), complete or not. */
  async current(): Promise<CompanySnapshot> {
    const view = await this.get();
    return {
      name: view.name ?? '',
      taxCode: view.taxCode ?? '',
      representative: view.representative ?? '',
      title: view.title ?? '',
      address: view.address ?? '',
      phone: view.phone,
      email: view.email,
      bankAccountNumber: view.bankAccountNumber,
      bankName: view.bankName,
    };
  }

  private view(row: SystemSettingEntity | null): CompanySettingsView {
    const value = row?.value ?? {};
    const settings = Object.fromEntries(
      COMPANY_FIELDS.map((field) => [field, clean(value[field])]),
    ) as CompanySettings;
    const missing = missingCompanyFields(settings);
    return {
      ...settings,
      complete: missing.length === 0,
      missing,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  }
}
