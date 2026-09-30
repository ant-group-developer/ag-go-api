import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { OutboxService } from '../../common/outbox.service';
import type { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { IN_FLIGHT_STATUSES } from '../../database/entities/asset-analysis.entity';
import type { AssetEntity } from '../../database/entities/asset.entity';
import { AnalysisEnqueueService } from './analysis-enqueue.service';

// uuid v14 is pure-ESM; mock it so Jest (CommonJS) can load the service under test.
// The factory uses a closure counter — unit tests only check that the returned value is truthy.
jest.mock('uuid', () => {
  let n = 0;
  return { v7: () => `00000000-0000-7000-0000-${String(++n).padStart(12, '0')}` };
});

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));

// ---------------------------------------------------------------------------
// Setup helper
// ---------------------------------------------------------------------------

function makeService(options: {
  autoEnqueue?: boolean;
  extractVersion?: string;
  promptVersion?: string;
}) {
  const { autoEnqueue = true, extractVersion = 'x1', promptVersion = 'p1' } = options;

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'ANALYSIS_AUTO_ENQUEUE') return autoEnqueue;
      if (key === 'ANALYSIS_EXTRACT_VERSION') return extractVersion;
      if (key === 'ANALYSIS_PROMPT_VERSION') return promptVersion;
      return undefined;
    }),
  } as unknown as ConfigService;

  const outboxEvent = { id: randomUUID(), eventType: 'asset.analysis.requested' };
  const outboxService = {
    create: jest.fn().mockReturnValue(outboxEvent),
  } as unknown as OutboxService;

  const service = new AnalysisEnqueueService(outboxService, config);

  return { service, config, outboxService };
}

function makeManager(options: {
  inFlightAnalysis?: Partial<AssetAnalysisEntity> | null;
  currentAnalysis?: Partial<AssetAnalysisEntity> | null;
}) {
  const { inFlightAnalysis = null, currentAnalysis = null } = options;

  const manager = {
    findOne: jest.fn().mockImplementation(async (_Entity: unknown, opts: { where: unknown }) => {
      // Distinguish the in-flight check (array of status conditions) from the
      // same-version current check (object with isCurrent).
      const where = opts?.where;
      if (Array.isArray(where)) {
        return inFlightAnalysis; // in-flight check
      }
      return currentAnalysis; // same-version current check
    }),
    create: jest.fn((_EntityClass: unknown, data: unknown) => ({ ...(data as object) })),
    save: jest.fn().mockResolvedValue(undefined),
  } as unknown as EntityManager;

  return manager;
}

const ASSET: Pick<AssetEntity, 'id'> = { id: randomUUID() };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalysisEnqueueService', () => {
  describe('isAutoEnqueueEnabled', () => {
    it('returns true when ANALYSIS_AUTO_ENQUEUE is true', () => {
      const { service } = makeService({ autoEnqueue: true });
      expect(service.isAutoEnqueueEnabled()).toBe(true);
    });

    it('returns false when ANALYSIS_AUTO_ENQUEUE is false', () => {
      const { service } = makeService({ autoEnqueue: false });
      expect(service.isAutoEnqueueEnabled()).toBe(false);
    });
  });

  describe('enqueueInsideTransaction', () => {
    it('creates an asset_analysis row and an outbox event when nothing is in flight', async () => {
      const { service, outboxService } = makeService({});
      const manager = makeManager({ inFlightAnalysis: null, currentAnalysis: null });

      const analysisId = await service.enqueueInsideTransaction(manager, ASSET);

      expect(analysisId).toBeTruthy();
      expect(manager.save).toHaveBeenCalledTimes(2); // analysis + outbox event
      expect(outboxService.create).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ eventType: 'asset.analysis.requested' }),
      );
    });

    it('returns null and skips when an in-flight analysis exists', async () => {
      const { service, outboxService } = makeService({});
      const inFlight: Partial<AssetAnalysisEntity> = {
        id: randomUUID(),
        status: 'extracting',
      };
      const manager = makeManager({ inFlightAnalysis: inFlight });

      const result = await service.enqueueInsideTransaction(manager, ASSET);

      expect(result).toBeNull();
      expect(outboxService.create).not.toHaveBeenCalled();
    });

    it('returns null when a current analysis with the same versions already exists', async () => {
      const { service, outboxService } = makeService({
        extractVersion: 'x1',
        promptVersion: 'p1',
      });
      const current: Partial<AssetAnalysisEntity> = {
        id: randomUUID(),
        status: 'completed',
        isCurrent: true,
        extractVersion: 'x1',
        promptVersion: 'p1',
      };
      const manager = makeManager({ inFlightAnalysis: null, currentAnalysis: current });

      const result = await service.enqueueInsideTransaction(manager, ASSET);

      expect(result).toBeNull();
      expect(outboxService.create).not.toHaveBeenCalled();
    });

    it('enqueues when skipIfCurrent=false even if current same-version analysis exists', async () => {
      const { service } = makeService({});
      const manager = makeManager({
        inFlightAnalysis: null,
        currentAnalysis: { id: randomUUID(), status: 'completed', isCurrent: true },
      });

      const result = await service.enqueueInsideTransaction(manager, ASSET, {
        skipIfCurrent: false,
      });

      expect(result).toBeTruthy();
    });

    it('enqueues when skipIfInFlight=false even if an analysis is in flight', async () => {
      const { service } = makeService({});
      const manager = makeManager({
        inFlightAnalysis: { id: randomUUID(), status: 'extracting' },
        currentAnalysis: null,
      });

      const result = await service.enqueueInsideTransaction(manager, ASSET, {
        skipIfInFlight: false,
      });

      expect(result).toBeTruthy();
    });

    it('sets the analysis status to queued', async () => {
      const { service } = makeService({});
      const manager = makeManager({});

      await service.enqueueInsideTransaction(manager, ASSET);

      const savedAnalysis = (manager.save as jest.Mock).mock.calls.find(
        ([EntityClass]: [unknown]) =>
          EntityClass === undefined || EntityClass === null || typeof EntityClass === 'object',
      );
      expect(savedAnalysis).toBeDefined();
      // The first save call should be the analysis entity
      const firstSaveArg = (manager.save as jest.Mock).mock
        .calls[0]?.[1] as Partial<AssetAnalysisEntity>;
      expect(firstSaveArg?.status).toBe('queued');
    });

    it('checks for all IN_FLIGHT_STATUSES when looking for in-flight analyses', async () => {
      const { service } = makeService({});
      const manager = makeManager({ inFlightAnalysis: null, currentAnalysis: null });

      await service.enqueueInsideTransaction(manager, ASSET);

      const [, where] = (manager.findOne as jest.Mock).mock.calls[0] as [
        unknown,
        { where: Array<{ status: string }> },
      ];
      const checkedStatuses = where.where.map((w) => w.status);
      expect(checkedStatuses).toEqual(expect.arrayContaining(IN_FLIGHT_STATUSES));
    });

    it('forwards requestedBy to the analysis entity', async () => {
      const { service } = makeService({});
      const manager = makeManager({});
      const userId = 'user-abc';

      await service.enqueueInsideTransaction(manager, ASSET, { requestedBy: userId });

      const firstSaveArg = (manager.save as jest.Mock).mock
        .calls[0]?.[1] as Partial<AssetAnalysisEntity>;
      expect(firstSaveArg?.requestedBy).toBe(userId);
    });
  });
});
