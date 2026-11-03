import type { AccountContractProfile } from '../account/account.types';
import { nextPartnerCode, partnerCodeBase } from './partner-code';
import {
  maskValue,
  profileCompleteness,
  toAccountChanges,
  toPartnerFieldNames,
  toProfileView,
} from './partner-profile';

function completeProfile(overrides: Partial<AccountContractProfile> = {}): AccountContractProfile {
  return {
    user_id: 'acc-1',
    name: 'Nguyễn Hữu Hoàng',
    citizen_id_number: '035086000130',
    id_issued_date: '2021-05-01',
    id_issued_place: 'Cục CS QLHC về TTXH',
    tax_number: '035086000130',
    phone_number: '0912345678',
    birthday: '1986-02-03',
    address: 'Hà Nội',
    permanent_address: 'Hà Nam',
    passport_number: null,
    contract_number: 'AM-01',
    contract_date: '2026-01-01',
    bank_account_name: 'NGUYEN HUU HOANG',
    bank_account_number: '0011006167',
    bank_code: '970436',
    bank_name: 'Vietcombank',
    tax_mode: 'WITHHOLD_10',
    bank_account_last4: '6167',
    passport_unreadable: false,
    bank_account_unreadable: false,
    updated_at: '2026-11-01T00:00:00.000Z',
    version: 'v-1',
    ...overrides,
  };
}

describe('partner code (BR-06)', () => {
  it('takes the initials without diacritics', () => {
    expect(partnerCodeBase('Nguyễn Hữu Hoàng')).toBe('NHH');
    expect(partnerCodeBase('Đỗ  Văn   Chí')).toBe('DVC');
    expect(partnerCodeBase('nguyễn thị xuân ngọc')).toBe('NTXN');
    expect(partnerCodeBase('  ')).toBe('CTV');
  });

  it('adds a number when the code is taken', () => {
    expect(nextPartnerCode('NHH', [])).toBe('NHH');
    expect(nextPartnerCode('NHH', ['NHH'])).toBe('NHH2');
    expect(nextPartnerCode('NHH', ['NHH', 'NHH2', 'nhh3'])).toBe('NHH4');
  });
});

describe('partner profile', () => {
  it('masks ID card, tax, phone, passport and bank numbers (FR-P-06)', () => {
    expect(maskValue('035086000130', 4, 2)).toBe('0350******30');
    expect(maskValue('12', 4, 2)).toBe('**');

    const view = toProfileView(completeProfile({ passport_number: 'C1234567' }), false);
    expect(view.revealed).toBe(false);
    expect(view.fields).toMatchObject({
      citizenIdNumber: '0350******30',
      taxNumber: '0350******30',
      phoneNumber: '09******78',
      passportNumber: 'C*****67',
      bankAccountNumber: '****6167',
      bankName: 'Vietcombank',
      permanentAddress: 'Hà Nam',
    });
    expect(JSON.stringify(view)).not.toContain('035086000130');
    expect(JSON.stringify(view)).not.toContain('0011006167');
    // AG Music's single contract fields are not part of AG Go's profile.
    expect(view.fields).not.toHaveProperty('contractNumber');
  });

  it('returns the values in full when revealed', () => {
    const view = toProfileView(completeProfile(), true);
    expect(view.fields.citizenIdNumber).toBe('035086000130');
    expect(view.fields.bankAccountNumber).toBe('0011006167');
    expect(view.version).toBe('v-1');
  });

  it('masks the bank account from its last 4 digits when the number is not returned', () => {
    const view = toProfileView(
      completeProfile({ bank_account_number: null, bank_account_last4: '9999' }),
      false,
    );
    expect(view.fields.bankAccountNumber).toBe('****9999');
  });

  it('is complete with every field of spec 7.1', () => {
    expect(profileCompleteness(completeProfile())).toEqual({ complete: true, missing: [] });
    // The bank may be given by its name only.
    expect(profileCompleteness(completeProfile({ bank_code: null })).complete).toBe(true);
  });

  it('lists the missing fields', () => {
    expect(
      profileCompleteness(
        completeProfile({
          birthday: null,
          tax_mode: '',
          bank_code: null,
          bank_name: null,
          permanent_address: '  ',
        }),
      ),
    ).toEqual({ complete: false, missing: ['birthday', 'permanentAddress', 'bank', 'taxMode'] });
  });

  it('counts an unreadable bank account as missing, not an unreadable passport', () => {
    expect(
      profileCompleteness(
        completeProfile({ bank_account_number: null, bank_account_unreadable: true }),
      ).missing,
    ).toEqual(['bankAccountNumber']);

    const view = toProfileView(
      completeProfile({ passport_number: null, passport_unreadable: true }),
      true,
    );
    expect(view.passportUnreadable).toBe(true);
    expect(view.completeness.complete).toBe(true);
  });

  it('sends only the fields given, empty strings as null', () => {
    expect(toAccountChanges({ phoneNumber: '0912345678', address: '', bankName: null })).toEqual({
      phone_number: '0912345678',
      address: null,
      bank_name: null,
    });
  });

  it('fills an emptied tax number with the ID card number sent (FR-P-04)', () => {
    expect(toAccountChanges({ citizenIdNumber: '035086000130', taxNumber: '' })).toEqual({
      citizen_id_number: '035086000130',
      tax_number: '035086000130',
    });
    expect(toAccountChanges({ citizenIdNumber: '035086000130' })).toEqual({
      citizen_id_number: '035086000130',
    });
    expect(toAccountChanges({ taxNumber: null })).toEqual({ tax_number: null });
  });

  it('names the changed fields like the API', () => {
    expect(toPartnerFieldNames(['bank_account_number', 'tax_mode', 'unknown'])).toEqual([
      'bankAccountNumber',
      'taxMode',
      'unknown',
    ]);
  });
});
