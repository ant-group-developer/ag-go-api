import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const runtimeConfig = app.get(ConfigService);
  const port = runtimeConfig.getOrThrow<number>('PORT');
  const prefix = runtimeConfig.getOrThrow<string>('API_PREFIX').replace(/^\/+|\/+$/g, '');
  const config = new DocumentBuilder()
    .setTitle('AG Go API')
    .setDescription('AG Go backend API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config, { ignoreGlobalPrefix: true });
  document.servers = [{ url: `http://localhost:${port}/${prefix}` }];
  document.components ??= {};
  document.components.schemas = {
    ...document.components.schemas,
    ApiError: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
        fieldErrors: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    ApiResponse: {
      type: 'object',
      required: ['data', 'requestId', 'timestamp', 'success', 'error'],
      properties: {
        data: {},
        requestId: { type: 'string' },
        timestamp: { type: 'string', format: 'date-time' },
        success: { type: 'boolean' },
        error: { allOf: [{ $ref: '#/components/schemas/ApiError' }], nullable: true },
      },
    },
    ListResponse: {
      type: 'object',
      required: ['items', 'page', 'pageSize', 'total', 'totalPages'],
      properties: {
        items: { type: 'array', items: {} },
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
        total: { type: 'integer' },
        totalPages: { type: 'integer' },
      },
    },
    CursorListResponse: {
      type: 'object',
      required: ['items', 'nextCursor'],
      properties: {
        items: { type: 'array', items: {} },
        nextCursor: { type: 'string', nullable: true },
      },
    },
    Asset: {
      type: 'object',
      required: [
        'id',
        'assetType',
        'originalFilename',
        'mimeType',
        'fileSizeBytes',
        'processingStatus',
      ],
      properties: {
        id: { type: 'string', format: 'uuid' },
        assetType: { type: 'string', enum: ['image', 'video'] },
        originalFilename: { type: 'string' },
        mimeType: { type: 'string' },
        fileSizeBytes: { type: 'string' },
        processingStatus: { type: 'string' },
        processingError: { type: 'string', nullable: true },
        sourceMetadata: { type: 'object', additionalProperties: true },
      },
    },
    ProjectMedia: {
      type: 'object',
      required: ['id', 'projectId', 'assetId', 'sortOrder', 'evaluationStatus', 'asset'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        projectId: { type: 'string', format: 'uuid' },
        assetId: { type: 'string', format: 'uuid' },
        sortOrder: { type: 'integer' },
        caption: { type: 'string', nullable: true },
        evaluationStatus: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        durationSeconds: { type: 'number', nullable: true },
        width: { type: 'integer', nullable: true },
        height: { type: 'integer', nullable: true },
        asset: { $ref: '#/components/schemas/Asset' },
      },
    },
    Project: {
      type: 'object',
      required: ['id', 'name', 'folderId', 'evaluationStatus'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        folderId: { type: 'string', format: 'uuid' },
        evaluationStatus: {
          type: 'string',
          enum: ['draft', 'pending', 'completed', 'partially_completed', 'failed'],
        },
        mediaCount: { type: 'integer', minimum: 0 },
        imageCount: { type: 'integer', minimum: 0 },
        videoCount: { type: 'integer', minimum: 0 },
        originalBytes: { type: 'string' },
        renderedBytes: { type: 'string' },
      },
    },
    EvaluationHistory: {
      type: 'object',
      required: ['id', 'projectMediaId', 'evaluationStatus', 'evaluatedBy', 'createdAt'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        projectMediaId: { type: 'string', format: 'uuid' },
        evaluationStatus: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        comment: { type: 'string', nullable: true },
        evaluatedBy: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  };
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const operation of Object.values(pathItem ?? {})) {
      if (!operation || typeof operation !== 'object' || !('responses' in operation)) {
        continue;
      }
      const responses = operation.responses as Record<
        string,
        { content?: Record<string, unknown> }
      >;
      for (const [status, response] of Object.entries(responses)) {
        if (!status.startsWith('2') || path.includes('/preview/')) {
          continue;
        }
        response.content ??= {};
        response.content['application/json'] ??= {
          schema: { $ref: '#/components/schemas/ApiResponse' },
        };
      }
    }
  }
  return document;
}
