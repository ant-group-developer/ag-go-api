import { Inject, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { AuthContextService } from '../../common/auth-context.service';
import { FolderAccessService } from '../folders/folder-access.service';
import { FootageScopeService } from '../footage/footage-scope.service';
import type { StudioUsageEventDto } from './dto/studio-events.dto';
import { StudioUsageController } from './studio-usage.controller';
import { StudioUsageService } from './studio-usage.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => Inject('ProjectEntityRepository'),
  InjectDataSource: () => () => undefined,
  getRepositoryToken: () => 'ProjectEntityRepository',
}));

describe('StudioUsageController body limit (e2e)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const mockRecord = jest.fn();

  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');

    const moduleRef = await Test.createTestingModule({
      controllers: [StudioUsageController],
      providers: [
        {
          provide: StudioUsageService,
          useValue: { record: mockRecord },
        },
        {
          provide: AuthContextService,
          useValue: {
            getContext: jest.fn().mockReturnValue({ userId: 'service:studio', serviceOnly: true }),
          },
        },
        {
          provide: FootageScopeService,
          useValue: {},
        },
        {
          provide: FolderAccessService,
          useValue: {},
        },
        {
          provide: 'ProjectEntityRepository',
          useValue: {},
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useLogger(false);

    // Mirrors main.ts configuration
    app.useBodyParser('json', { limit: '2mb' });
    app.useBodyParser('urlencoded', { extended: true, limit: '2mb' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidUnknownValues: true,
      }),
    );

    await app.init();

    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(() => {
    mockRecord.mockReset();
  });

  function createValidEvent(index: number): StudioUsageEventDto {
    const assetId = randomUUID();
    return {
      eventKey: `studio:event:${index}:${assetId}`,
      kind: 'source_added',
      occurredAt: '2026-10-20T08:00:00.000Z',
      assetId,
      studioProjectId: `proj_${index}`,
      studioProjectName: `Dự án Studio Video Marketing Số ${index} - Bản Chi Tiết Dài`,
      studioVideoId: `vid_${index}`,
      studioVideoTitle: `Video Tiêu Đề Chi Tiết Số ${index} Cho Chiến Dịch Marketing Mùa Thu`,
      studioUserId: 'auth0|studio-user-uuid-12345',
    };
  }

  it('accepts a batch of 500 events (> 100KB default Express limit)', async () => {
    const events: StudioUsageEventDto[] = [];
    for (let i = 0; i < 500; i++) {
      events.push(createValidEvent(i));
    }

    const payload = JSON.stringify({ events });
    const payloadBytes = Buffer.byteLength(payload);
    // Verify that the payload is well above the 100KB default Express limit
    expect(payloadBytes).toBeGreaterThan(120 * 1024);

    mockRecord.mockResolvedValueOnce({ accepted: 500, duplicates: 0 });

    const response = await fetch(`${baseUrl}/usage/studio-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ accepted: 500, duplicates: 0 });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toHaveLength(500);
  });

  it('rejects with 413 Payload Too Large when payload exceeds 2MB', async () => {
    // Construct a payload larger than 2MB
    const oversizedPadding = 'x'.repeat(2.1 * 1024 * 1024);
    const payload = JSON.stringify({
      events: [createValidEvent(1)],
      padding: oversizedPadding,
    });

    expect(Buffer.byteLength(payload)).toBeGreaterThan(2 * 1024 * 1024);

    const response = await fetch(`${baseUrl}/usage/studio-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: payload,
    });

    expect(response.status).toBe(413);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('rejects with 400 Bad Request when events array exceeds 500 items', async () => {
    const events: StudioUsageEventDto[] = [];
    for (let i = 0; i < 501; i++) {
      events.push(createValidEvent(i));
    }

    const response = await fetch(`${baseUrl}/usage/studio-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ events }),
    });

    expect(response.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
