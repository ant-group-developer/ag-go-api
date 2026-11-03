import {
  canTransitionPackage,
  nextPackageStatus,
  packageCode,
  packageCodePrefix,
  PackageTransitionError,
} from '../packages/package-state';
import {
  acceptanceEditable,
  AcceptanceTransitionError,
  actionLevel,
  canTransitionAcceptance,
  nextAcceptanceStatus,
} from './acceptance-state';

describe('acceptance record state machine (spec 5.3)', () => {
  it('follows draft → submitted → approved → issued → signed', () => {
    expect(nextAcceptanceStatus('draft', 'submit')).toBe('submitted');
    expect(nextAcceptanceStatus('submitted', 'return')).toBe('draft');
    expect(nextAcceptanceStatus('submitted', 'approve')).toBe('approved');
    expect(nextAcceptanceStatus('approved', 'issue')).toBe('issued');
    expect(nextAcceptanceStatus('issued', 'sign')).toBe('signed');
    for (const status of ['draft', 'submitted', 'approved', 'issued'] as const) {
      expect(nextAcceptanceStatus(status, 'cancel')).toBe('cancelled');
    }
    expect(canTransitionAcceptance('signed', 'cancel')).toBe(false);
    expect(() => nextAcceptanceStatus('draft', 'issue')).toThrow(AcceptanceTransitionError);
  });

  it('needs prepare to submit and cancel drafts, approve for the rest', () => {
    expect(actionLevel('submit', 'draft')).toBe('prepare');
    expect(actionLevel('cancel', 'submitted')).toBe('prepare');
    expect(actionLevel('cancel', 'issued')).toBe('approve');
    expect(actionLevel('approve', 'submitted')).toBe('approve');
    expect(acceptanceEditable('draft')).toBe(true);
    expect(acceptanceEditable('issued')).toBe(false);
  });
});

describe('package state machine (spec 7.4.1)', () => {
  it('moves between open, submitted, evaluated and accepted', () => {
    expect(nextPackageStatus('open', 'submit')).toBe('submitted');
    expect(nextPackageStatus('submitted', 'evaluate')).toBe('evaluated');
    expect(nextPackageStatus('evaluated', 'unevaluate')).toBe('submitted');
    expect(nextPackageStatus('evaluated', 'reopen')).toBe('open');
    expect(nextPackageStatus('evaluated', 'accept')).toBe('accepted');
    expect(nextPackageStatus('accepted', 'unaccept')).toBe('evaluated');
    expect(nextPackageStatus('submitted', 'return')).toBe('open');
    expect(canTransitionPackage('accepted', 'cancel')).toBe(false);
    expect(() => nextPackageStatus('open', 'accept')).toThrow(PackageTransitionError);
  });

  it('codes packages from the category slug and the partner code', () => {
    expect(packageCodePrefix('kham-pha')).toBe('KP');
    expect(packageCodePrefix('canh')).toBe('CA');
    expect(packageCodePrefix('Đời sống')).toBe('DS');
    expect(packageCodePrefix('')).toBe('PK');
    expect(packageCode('KP', 'NBN', 12)).toBe('KP-NBN-0012');
  });
});
