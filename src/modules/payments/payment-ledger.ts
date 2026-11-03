/**
 * Pure money rules of payments and the contract ledger (spec 6.6, BR-32…35, FR-C-09, FR-C-10), in
 * whole đồng. No database here: the services load the facts and call these functions, so the
 * numbers on the ledger, the reports and the checks before recording a payment are the same.
 */

/** Acceptance statuses whose amounts are final (issued and later, not cancelled). */
export const ISSUED_ACCEPTANCE_STATUSES = ['issued', 'signed', 'partially_paid', 'paid'] as const;

/** Statuses an acceptance record is paid in (spec 5.3: after signing). */
export const PAYABLE_ACCEPTANCE_STATUSES = ['signed', 'partially_paid'] as const;

export type AdvanceFacts = {
  /** Advances recorded (kind `advance`, not cancelled). */
  advancesPaid: number;
  /** Advances returned by the partner (kind `refund`, not cancelled). */
  refunds: number;
  /** Advance left on an imported contract before AG Go (FR-C-11); 0 otherwise. */
  legacyAdvanceBalance: number;
  /** Offsets of the acceptance records counted against the advance. */
  offsets: number;
};

/**
 * Advance paid and not yet offset nor returned: advances actually paid + the imported balance −
 * refunds − offsets. Negative only when data are inconsistent (e.g. an advance cancelled after it
 * was offset); callers block the actions that would lead there.
 */
export function advanceBalance(facts: AdvanceFacts): number {
  return facts.advancesPaid + facts.legacyAdvanceBalance - facts.refunds - facts.offsets;
}

/** What is left to pay on an acceptance record (never negative). */
export function remainingPayable(netPayable: number, paid: number): number {
  return Math.max(0, netPayable - paid);
}

/**
 * Status of a signed record after its payments (FR-$-02): fully paid when the payments reach the
 * net payable (a record with nothing to pay is paid once signed), partly paid when something was
 * paid, signed otherwise.
 */
export function paymentStatus(
  netPayable: number,
  paid: number,
): 'signed' | 'partially_paid' | 'paid' {
  if (paid >= netPayable) {
    return 'paid';
  }
  return paid > 0 ? 'partially_paid' : 'signed';
}

/** Whole days from `from` to `to` (YYYY-MM-DD), negative when `to` is before. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

/**
 * Days a record is past its payment due date (BR-34) on `today`, 0 when not overdue: only records
 * with something left to pay and a due date before today.
 */
export function overdueDays(dueDate: string | null, remaining: number, today: string): number {
  if (!dueDate || remaining <= 0) {
    return 0;
  }
  return Math.max(0, daysBetween(dueDate, today));
}

export type CapAlert = 'none' | 'reached_80' | 'reached_100' | 'exceeded';

/** FR-C-09: share of the ceiling used by the accepted value and the alert level. */
export function capUsage(
  accepted: number,
  capAmount: number | null,
): { ratio: number | null; alert: CapAlert } {
  if (capAmount === null || capAmount <= 0) {
    return { ratio: null, alert: 'none' };
  }
  const ratio = Math.round((accepted / capAmount) * 10_000) / 10_000;
  if (accepted > capAmount) {
    return { ratio, alert: 'exceeded' };
  }
  if (accepted === capAmount) {
    return { ratio, alert: 'reached_100' };
  }
  return { ratio, alert: ratio >= 0.8 ? 'reached_80' : 'none' };
}

export type LedgerRecord = {
  id: string;
  status: string;
  grossAmount: number;
  taxAmount: number;
  advanceOffsetAmount: number;
  netPayable: number;
  /** Settlements recorded for the record (not cancelled). */
  paid: number;
  dueDate: string | null;
};

export type LedgerContract = {
  status: string;
  capAmount: number | null;
  /** Agreed advance (FR-C-04). */
  advanceAmount: number;
  penaltyPercent: number;
  legacyAcceptedAmount: number | null;
  legacyPaidAmount: number | null;
  legacyAdvanceBalance: number | null;
};

export type LedgerInput<R extends LedgerRecord = LedgerRecord> = {
  contract: LedgerContract;
  /** Acceptance records issued or later, not cancelled. */
  records: readonly R[];
  /** Advance offsets of records still being prepared (draft / submitted / approved). */
  pendingOffsets: number;
  advancesPaid: number;
  refunds: number;
  today: string;
};

export type LedgerRecordLine<R extends LedgerRecord = LedgerRecord> = R & {
  remaining: number;
  overdueDays: number;
};

export type Ledger<R extends LedgerRecord = LedgerRecord> = {
  /** Accepted value: imported before AG Go + issued records. */
  acceptedAmount: number;
  legacyAcceptedAmount: number;
  grossAmount: number;
  taxAmount: number;
  advanceOffsetAmount: number;
  /** Net payable of the issued records (thực lĩnh). */
  netPayable: number;
  settlementsPaid: number;
  legacyPaidAmount: number;
  advanceAmount: number;
  advancesPaid: number;
  /** Agreed advance not paid yet (0 when more was paid). */
  advanceNotPaid: number;
  refunds: number;
  advanceBalance: number;
  /** Offsets of records not issued yet, reserved on the balance. */
  pendingAdvanceOffset: number;
  /** Paid out to the partner: advances + settlements + paid before AG Go − refunds. */
  totalPaid: number;
  /** Net payable of the issued records not paid yet (còn phải trả). */
  outstanding: number;
  overdueAmount: number;
  overdueCount: number;
  capAmount: number | null;
  capRatio: number | null;
  capAlert: CapAlert;
  capRemaining: number | null;
  /** FR-C-10 / BR-35: advance the partner has to return once the contract is closed. */
  refundDue: number;
  /** BR-35: penalty for a unilateral termination by the partner, for reference. */
  penaltyReference: number | null;
  /** gross − tax − offset = net on every record: the ledger matches the records (FR-$-04). */
  balanced: boolean;
  records: Array<LedgerRecordLine<R>>;
};

/** Ledger of one contract (FR-$-04): accepted, tax, net, paid, advance, outstanding, ceiling. */
export function buildLedger<R extends LedgerRecord>(input: LedgerInput<R>): Ledger<R> {
  const { contract } = input;
  let grossAmount = 0;
  let taxAmount = 0;
  let advanceOffsetAmount = 0;
  let netPayable = 0;
  let settlementsPaid = 0;
  let outstanding = 0;
  let overdueAmount = 0;
  let overdueCount = 0;
  let balanced = true;
  const records = input.records.map((record): LedgerRecordLine<R> => {
    grossAmount += record.grossAmount;
    taxAmount += record.taxAmount;
    advanceOffsetAmount += record.advanceOffsetAmount;
    netPayable += record.netPayable;
    settlementsPaid += record.paid;
    if (record.grossAmount - record.taxAmount - record.advanceOffsetAmount !== record.netPayable) {
      balanced = false;
    }
    const remaining = remainingPayable(record.netPayable, record.paid);
    const late = overdueDays(record.dueDate, remaining, input.today);
    outstanding += remaining;
    if (late > 0) {
      overdueAmount += remaining;
      overdueCount += 1;
    }
    return { ...record, remaining, overdueDays: late };
  });
  const legacyAcceptedAmount = contract.legacyAcceptedAmount ?? 0;
  const legacyPaidAmount = contract.legacyPaidAmount ?? 0;
  const acceptedAmount = legacyAcceptedAmount + grossAmount;
  const balance = advanceBalance({
    advancesPaid: input.advancesPaid,
    refunds: input.refunds,
    legacyAdvanceBalance: contract.legacyAdvanceBalance ?? 0,
    offsets: advanceOffsetAmount,
  });
  const cap = capUsage(acceptedAmount, contract.capAmount);
  const closed = contract.status === 'terminated' || contract.status === 'completed';
  return {
    acceptedAmount,
    legacyAcceptedAmount,
    grossAmount,
    taxAmount,
    advanceOffsetAmount,
    netPayable,
    settlementsPaid,
    legacyPaidAmount,
    advanceAmount: contract.advanceAmount,
    advancesPaid: input.advancesPaid,
    advanceNotPaid: Math.max(0, contract.advanceAmount - input.advancesPaid),
    refunds: input.refunds,
    advanceBalance: balance,
    pendingAdvanceOffset: input.pendingOffsets,
    totalPaid: input.advancesPaid + settlementsPaid + legacyPaidAmount - input.refunds,
    outstanding,
    overdueAmount,
    overdueCount,
    capAmount: contract.capAmount,
    capRatio: cap.ratio,
    capAlert: cap.alert,
    capRemaining:
      contract.capAmount === null ? null : Math.max(0, contract.capAmount - acceptedAmount),
    refundDue: closed ? Math.max(0, balance) : 0,
    penaltyReference:
      contract.status === 'terminated' && contract.capAmount !== null
        ? Math.round((contract.capAmount * contract.penaltyPercent) / 100)
        : null,
    balanced,
    records,
  };
}

export type PaymentCheckError =
  | { code: 'PAYMENT_EXCEEDS_REMAINING'; remaining: number }
  | { code: 'PAYMENT_ADVANCE_NOT_AGREED' }
  | { code: 'PAYMENT_ADVANCE_EXCEEDS_AGREED'; room: number }
  | { code: 'PAYMENT_REFUND_EXCEEDS_BALANCE'; balance: number };

/** A settlement must not pay more than what is left on the record (FR-$-02). */
export function checkSettlement(
  amount: number,
  netPayable: number,
  paid: number,
): PaymentCheckError | null {
  const remaining = remainingPayable(netPayable, paid);
  return amount > remaining ? { code: 'PAYMENT_EXCEEDS_REMAINING', remaining } : null;
}

/** Advances paid stay within the agreed advance (FR-C-04); refunds already returned count back. */
export function checkAdvance(
  amount: number,
  agreed: number,
  advancesPaid: number,
  refunds: number,
): PaymentCheckError | null {
  if (agreed <= 0) {
    return { code: 'PAYMENT_ADVANCE_NOT_AGREED' };
  }
  const room = Math.max(0, agreed - (advancesPaid - refunds));
  return amount > room ? { code: 'PAYMENT_ADVANCE_EXCEEDS_AGREED', room } : null;
}

/** A refund returns at most the advance balance (offsets of records not cancelled counted). */
export function checkRefund(amount: number, balance: number): PaymentCheckError | null {
  return amount > Math.max(0, balance)
    ? { code: 'PAYMENT_REFUND_EXCEEDS_BALANCE', balance: Math.max(0, balance) }
    : null;
}
