/** A field value as shown in the audit log: plain text, a list (e.g. tags) or empty. */
export type AuditValue = string | number | string[] | null;

/** One changed field of an audit entry; `field` is a stable key the web app translates. */
export type AuditChange = { field: string; from: AuditValue; to: AuditValue };

function normalize(value: AuditValue | undefined): AuditValue {
  if (value === undefined || value === '') {
    return null;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? null : value;
  }
  return value;
}

function sameValue(left: AuditValue, right: AuditValue): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    // Tag order is not meaningful.
    return (
      left.length === right.length && [...left].sort().join('\n') === [...right].sort().join('\n')
    );
  }
  return left === right;
}

/**
 * Human-readable diff of two snapshots for the audit log: only the fields whose value differs,
 * in the order of `before`'s keys. Empty strings and empty lists count as "no value".
 */
export function diffAuditSnapshots(
  before: Record<string, AuditValue | undefined>,
  after: Record<string, AuditValue | undefined>,
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of Object.keys(before)) {
    const from = normalize(before[field]);
    const to = normalize(after[field]);
    if (!sameValue(from, to)) {
      changes.push({ field, from, to });
    }
  }
  return changes;
}
