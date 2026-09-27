import type { Logger } from '@nestjs/common';
import type { AuditService } from '../audit/audit.service';

/**
 * Project audit actions of Google Drive imports. They are recorded per batch, not per file, so a
 * folder of a thousand files adds a handful of entries instead of flooding the project log.
 */
export const IMPORT_AUDIT_ACTIONS = {
  started: 'import_started',
  paused: 'import_paused',
  resumed: 'import_resumed',
  cancelled: 'import_cancelled',
  completed: 'import_completed',
  partial: 'import_partial',
  failed: 'import_failed',
} as const;

export type ImportAuditAction = (typeof IMPORT_AUDIT_ACTIONS)[keyof typeof IMPORT_AUDIT_ACTIONS];

/** Batch statuses that end an import run, mapped to the audit action recorded for them. */
export const IMPORT_FINISHED_AUDIT_ACTIONS: Record<string, ImportAuditAction> = {
  completed: IMPORT_AUDIT_ACTIONS.completed,
  partial: IMPORT_AUDIT_ACTIONS.partial,
  failed: IMPORT_AUDIT_ACTIONS.failed,
};

/**
 * Best effort: a failed audit write is logged and never fails the import action or the worker
 * that triggered it.
 */
export async function recordImportAudit(
  auditService: AuditService,
  logger: Logger,
  input: {
    projectId: string;
    batchId: string;
    actorUserId: string;
    action: ImportAuditAction;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await auditService.record({
      projectId: input.projectId,
      actorUserId: input.actorUserId,
      action: input.action,
      afterData: { batchId: input.batchId, ...input.data },
      metadata: { batchId: input.batchId, source: 'google_drive' },
    });
  } catch (error) {
    logger.warn(
      `Could not record ${input.action} audit for import ${input.batchId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
