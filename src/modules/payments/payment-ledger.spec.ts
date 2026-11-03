import {
  advanceBalance,
  buildLedger,
  capUsage,
  checkAdvance,
  checkRefund,
  checkSettlement,
  daysBetween,
  overdueDays,
  paymentStatus,
  remainingPayable,
  type LedgerContract,
  type LedgerRecord,
} from './payment-ledger';

const contract: LedgerContract = {
  status: 'active',
  capAmount: 100_000_000,
  advanceAmount: 50_000_000,
  penaltyPercent: 8,
  legacyAcceptedAmount: null,
  legacyPaidAmount: null,
  legacyAdvanceBalance: null,
};

/** TC-3 / TC-4: 61 shots × 300.000, tax 10%. */
function record(overrides: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    id: 'r1',
    status: 'signed',
    grossAmount: 18_300_000,
    taxAmount: 1_830_000,
    advanceOffsetAmount: 16_470_000,
    netPayable: 0,
    paid: 0,
    dueDate: '2026-10-23',
    ...overrides,
  };
}

describe('advanceBalance (BR-32)', () => {
  it('TC-4: 50.000.000 paid, 16.470.000 offset → 33.530.000 left', () => {
    expect(
      advanceBalance({
        advancesPaid: 50_000_000,
        refunds: 0,
        legacyAdvanceBalance: 0,
        offsets: 16_470_000,
      }),
    ).toBe(33_530_000);
  });

  it('counts the balance carried by an imported contract and refunds', () => {
    expect(
      advanceBalance({
        advancesPaid: 10_000_000,
        refunds: 3_000_000,
        legacyAdvanceBalance: 5_000_000,
        offsets: 2_000_000,
      }),
    ).toBe(10_000_000);
  });

  it('an agreed advance not paid yet is no balance', () => {
    expect(
      advanceBalance({ advancesPaid: 0, refunds: 0, legacyAdvanceBalance: 0, offsets: 0 }),
    ).toBe(0);
  });
});

describe('remaining and payment status (FR-$-02)', () => {
  it('remaining never goes negative', () => {
    expect(remainingPayable(6_470_000, 3_000_000)).toBe(3_470_000);
    expect(remainingPayable(6_470_000, 7_000_000)).toBe(0);
  });

  it('signed → partially_paid → paid; nothing to pay is paid', () => {
    expect(paymentStatus(6_470_000, 0)).toBe('signed');
    expect(paymentStatus(6_470_000, 3_000_000)).toBe('partially_paid');
    expect(paymentStatus(6_470_000, 6_470_000)).toBe('paid');
    expect(paymentStatus(0, 0)).toBe('paid');
  });
});

describe('overdue (BR-34, FR-$-03)', () => {
  it('counts days after the due date only while something is left to pay', () => {
    expect(daysBetween('2026-10-23', '2026-11-03')).toBe(11);
    expect(overdueDays('2026-10-23', 1_000, '2026-11-03')).toBe(11);
    expect(overdueDays('2026-10-23', 1_000, '2026-10-23')).toBe(0);
    expect(overdueDays('2026-10-23', 0, '2026-11-03')).toBe(0);
    expect(overdueDays(null, 1_000, '2026-11-03')).toBe(0);
  });
});

describe('ceiling usage (FR-C-09)', () => {
  it('alerts at 80%, 100% and over', () => {
    expect(capUsage(79_000_000, 100_000_000)).toEqual({ ratio: 0.79, alert: 'none' });
    expect(capUsage(80_000_000, 100_000_000)).toEqual({ ratio: 0.8, alert: 'reached_80' });
    expect(capUsage(100_000_000, 100_000_000)).toEqual({ ratio: 1, alert: 'reached_100' });
    expect(capUsage(100_000_001, 100_000_000).alert).toBe('exceeded');
    expect(capUsage(5, null)).toEqual({ ratio: null, alert: 'none' });
  });
});

describe('payment checks', () => {
  it('a settlement pays at most what is left', () => {
    expect(checkSettlement(3_470_000, 6_470_000, 3_000_000)).toBeNull();
    expect(checkSettlement(3_470_001, 6_470_000, 3_000_000)).toEqual({
      code: 'PAYMENT_EXCEEDS_REMAINING',
      remaining: 3_470_000,
    });
  });

  it('advances stay within the agreed advance', () => {
    expect(checkAdvance(1, 0, 0, 0)).toEqual({ code: 'PAYMENT_ADVANCE_NOT_AGREED' });
    expect(checkAdvance(50_000_000, 50_000_000, 0, 0)).toBeNull();
    expect(checkAdvance(1, 50_000_000, 50_000_000, 0)).toEqual({
      code: 'PAYMENT_ADVANCE_EXCEEDS_AGREED',
      room: 0,
    });
    expect(checkAdvance(5_000_000, 50_000_000, 50_000_000, 5_000_000)).toBeNull();
  });

  it('a refund returns at most the balance', () => {
    expect(checkRefund(33_530_000, 33_530_000)).toBeNull();
    expect(checkRefund(33_530_001, 33_530_000)).toEqual({
      code: 'PAYMENT_REFUND_EXCEEDS_BALANCE',
      balance: 33_530_000,
    });
    expect(checkRefund(1, -5)).toEqual({ code: 'PAYMENT_REFUND_EXCEEDS_BALANCE', balance: 0 });
  });
});

describe('buildLedger (FR-$-04)', () => {
  it('TC-4: advance 50.000.000, one record offsetting 16.470.000 → nothing to pay, 33.530.000 left', () => {
    const ledger = buildLedger({
      contract,
      records: [record({ status: 'paid' })],
      pendingOffsets: 0,
      advancesPaid: 50_000_000,
      refunds: 0,
      today: '2026-11-03',
    });
    expect(ledger).toMatchObject({
      acceptedAmount: 18_300_000,
      taxAmount: 1_830_000,
      advanceOffsetAmount: 16_470_000,
      netPayable: 0,
      advancesPaid: 50_000_000,
      advanceNotPaid: 0,
      advanceBalance: 33_530_000,
      totalPaid: 50_000_000,
      outstanding: 0,
      overdueAmount: 0,
      capRatio: 0.183,
      capAlert: 'none',
      capRemaining: 81_700_000,
      refundDue: 0,
      penaltyReference: null,
      balanced: true,
    });
  });

  it('partly paid and overdue records, a terminated contract owing its advance back', () => {
    const ledger = buildLedger({
      contract: {
        ...contract,
        status: 'terminated',
        legacyAcceptedAmount: 70_000_000,
        legacyPaidAmount: 63_000_000,
      },
      records: [
        record({
          id: 'a',
          status: 'partially_paid',
          advanceOffsetAmount: 10_000_000,
          netPayable: 6_470_000,
          paid: 3_000_000,
          dueDate: '2026-10-01',
        }),
        record({
          id: 'b',
          advanceOffsetAmount: 0,
          netPayable: 16_470_000,
          paid: 0,
          dueDate: '2026-12-01',
        }),
      ],
      pendingOffsets: 1_000_000,
      advancesPaid: 30_000_000,
      refunds: 5_000_000,
      today: '2026-11-03',
    });
    expect(ledger).toMatchObject({
      acceptedAmount: 106_600_000,
      grossAmount: 36_600_000,
      netPayable: 22_940_000,
      settlementsPaid: 3_000_000,
      advanceAmount: 50_000_000,
      advanceNotPaid: 20_000_000,
      advanceBalance: 15_000_000,
      pendingAdvanceOffset: 1_000_000,
      totalPaid: 30_000_000 + 3_000_000 + 63_000_000 - 5_000_000,
      outstanding: 3_470_000 + 16_470_000,
      overdueAmount: 3_470_000,
      overdueCount: 1,
      capAlert: 'exceeded',
      capRemaining: 0,
      refundDue: 15_000_000,
      penaltyReference: 8_000_000,
    });
    expect(ledger.records.map((line) => [line.id, line.remaining, line.overdueDays])).toEqual([
      ['a', 3_470_000, 33],
      ['b', 16_470_000, 0],
    ]);
  });

  it('flags records whose amounts do not add up', () => {
    const ledger = buildLedger({
      contract,
      records: [record({ netPayable: 5 })],
      pendingOffsets: 0,
      advancesPaid: 0,
      refunds: 0,
      today: '2026-11-03',
    });
    expect(ledger.balanced).toBe(false);
  });
});
