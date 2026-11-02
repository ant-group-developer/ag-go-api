import type {
  AccountContractProfile,
  AccountContractProfileChanges,
  AccountContractProfileField,
} from '../account/account.types';

/**
 * Contract-profile fields AG Go reads and writes, camelCase (API) → AG Account name.
 * `contract_number` / `contract_date` are AG Music's (one contract per person) and left out.
 */
export const PROFILE_FIELD_MAP = {
  citizenIdNumber: 'citizen_id_number',
  idIssuedDate: 'id_issued_date',
  idIssuedPlace: 'id_issued_place',
  taxNumber: 'tax_number',
  phoneNumber: 'phone_number',
  birthday: 'birthday',
  address: 'address',
  permanentAddress: 'permanent_address',
  passportNumber: 'passport_number',
  bankAccountName: 'bank_account_name',
  bankAccountNumber: 'bank_account_number',
  bankCode: 'bank_code',
  bankName: 'bank_name',
  taxMode: 'tax_mode',
} as const satisfies Record<string, AccountContractProfileField>;

export type PartnerProfileField = keyof typeof PROFILE_FIELD_MAP;

export const PARTNER_PROFILE_FIELDS = Object.keys(PROFILE_FIELD_MAP) as PartnerProfileField[];

export type PartnerProfileValues = Record<PartnerProfileField, string | null>;

/**
 * Values never returned in full without `go.partner.pii_read` + `?reveal=pii` (FR-P-06), with how
 * many leading / trailing characters stay visible.
 */
const MASKS: Partial<Record<PartnerProfileField, { start: number; end: number }>> = {
  citizenIdNumber: { start: 4, end: 2 },
  taxNumber: { start: 4, end: 2 },
  phoneNumber: { start: 2, end: 2 },
  passportNumber: { start: 1, end: 2 },
  bankAccountNumber: { start: 0, end: 4 },
};

export const MASKED_PROFILE_FIELDS = Object.keys(MASKS) as PartnerProfileField[];

/**
 * Required to sign a contract (spec 7.1): full name (always present in AG Account), birth date, ID
 * card number, issue date and place, permanent address, phone, tax number, account holder, account
 * number, bank and tax mode. The bank counts as given by its code or its name.
 */
export const REQUIRED_PROFILE_FIELDS = [
  'birthday',
  'citizenIdNumber',
  'idIssuedDate',
  'idIssuedPlace',
  'permanentAddress',
  'phoneNumber',
  'taxNumber',
  'bankAccountName',
  'bankAccountNumber',
  'bank',
  'taxMode',
] as const;

export type RequiredProfileField = (typeof REQUIRED_PROFILE_FIELDS)[number] | 'name';

export type ProfileCompleteness = {
  complete: boolean;
  missing: RequiredProfileField[];
};

export type PartnerProfileView = {
  accountUserId: string;
  name: string;
  /** True when the values are in full (`?reveal=pii` with `go.partner.pii_read`). */
  revealed: boolean;
  fields: PartnerProfileValues;
  bankAccountLast4: string | null;
  /** Passport stored in AG Account but unreadable: show "needs re-entry", not "empty". */
  passportUnreadable: boolean;
  bankAccountUnreadable: boolean;
  completeness: ProfileCompleteness;
  /** Send back as `version` when patching (If-Match). */
  version: string;
  updatedAt: string | null;
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function profileValues(profile: AccountContractProfile): PartnerProfileValues {
  return Object.fromEntries(
    PARTNER_PROFILE_FIELDS.map((field) => [field, text(profile[PROFILE_FIELD_MAP[field]])]),
  ) as PartnerProfileValues;
}

/** `035086000130` → `0350******30`; values too short to hide anything become all stars. */
export function maskValue(value: string, start: number, end: number): string {
  if (value.length <= start + end) {
    return '*'.repeat(value.length);
  }
  return `${value.slice(0, start)}${'*'.repeat(value.length - start - end)}${
    end > 0 ? value.slice(-end) : ''
  }`;
}

export function maskProfileValues(
  values: PartnerProfileValues,
  bankAccountLast4: string | null,
): PartnerProfileValues {
  const masked = { ...values };
  for (const field of MASKED_PROFILE_FIELDS) {
    const value = values[field];
    const mask = MASKS[field]!;
    if (field === 'bankAccountNumber') {
      const last4 = value ? value.slice(-4) : bankAccountLast4;
      masked[field] = last4 ? `****${last4}` : null;
    } else {
      masked[field] = value ? maskValue(value, mask.start, mask.end) : null;
    }
  }
  return masked;
}

export function profileCompleteness(profile: AccountContractProfile): ProfileCompleteness {
  const values = profileValues(profile);
  const missing: RequiredProfileField[] = [];
  if (!text(profile.name)) {
    missing.push('name');
  }
  for (const field of REQUIRED_PROFILE_FIELDS) {
    if (field === 'bank') {
      if (!values.bankCode && !values.bankName) {
        missing.push(field);
      }
    } else if (field === 'bankAccountNumber') {
      // An unreadable number must be entered again before it can go on a contract.
      if (
        profile.bank_account_unreadable ||
        (!values.bankAccountNumber && !profile.bank_account_last4)
      ) {
        missing.push(field);
      }
    } else if (!values[field]) {
      missing.push(field);
    }
  }
  return { complete: missing.length === 0, missing };
}

export function toProfileView(
  profile: AccountContractProfile,
  reveal: boolean,
): PartnerProfileView {
  const values = profileValues(profile);
  return {
    accountUserId: profile.user_id,
    name: profile.name,
    revealed: reveal,
    fields: reveal ? values : maskProfileValues(values, profile.bank_account_last4 ?? null),
    bankAccountLast4: profile.bank_account_last4 ?? null,
    passportUnreadable: profile.passport_unreadable === true,
    bankAccountUnreadable: profile.bank_account_unreadable === true,
    completeness: profileCompleteness(profile),
    version: profile.version,
    updatedAt: profile.updated_at ?? null,
  };
}

/**
 * PATCH body → AG Account changes: only the keys sent, an empty string clears (null). An emptied
 * tax number takes the ID card number sent with it (FR-P-04: the personal tax number defaults to
 * the ID card number).
 */
export function toAccountChanges(
  input: Partial<Record<PartnerProfileField, string | null>>,
): AccountContractProfileChanges {
  const changes: AccountContractProfileChanges = {};
  for (const field of PARTNER_PROFILE_FIELDS) {
    const value = input[field];
    if (value !== undefined) {
      changes[PROFILE_FIELD_MAP[field]] = value === null ? null : value.trim() || null;
    }
  }
  if (
    'tax_number' in changes &&
    changes.tax_number === null &&
    typeof changes.citizen_id_number === 'string'
  ) {
    changes.tax_number = changes.citizen_id_number;
  }
  return changes;
}

/** AG Account field names → camelCase names of this API (unknown names are kept). */
export function toPartnerFieldNames(fields: readonly string[]): string[] {
  const reverse = new Map<string, string>(
    Object.entries(PROFILE_FIELD_MAP).map(([camel, snake]) => [snake, camel]),
  );
  return fields.map((field) => reverse.get(field) ?? field);
}
