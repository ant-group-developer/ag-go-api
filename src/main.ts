import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { corsOrigins } from './config/cors-origins';
import { AssetsService } from './modules/assets/assets.service';
import { createOpenApiDocument } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const prefix = config.getOrThrow<string>('API_PREFIX');
  const isProduction = config.get<string>('NODE_ENV') === 'production';

  const expressApp = app.getHttpAdapter().getInstance();
  if (typeof expressApp?.set === 'function') {
    expressApp.set('trust proxy', 1);
  }

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: isProduction ? undefined : false,
    }),
  );

  app.setGlobalPrefix(prefix);
  app.enableCors({
    origin: corsOrigins(
      config.getOrThrow<string>('FRONTEND_ORIGIN'),
      config.get<string>('CORS_EXTRA_ORIGINS'),
    ),
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: true,
    }),
  );

  const swaggerEnabled =
    config.get<boolean | string>('SWAGGER_ENABLED') === true ||
    config.get<boolean | string>('SWAGGER_ENABLED') === 'true' ||
    (!isProduction &&
      config.get<boolean | string>('SWAGGER_ENABLED') !== false &&
      config.get<boolean | string>('SWAGGER_ENABLED') !== 'false');

  if (swaggerEnabled) {
    const document = createOpenApiDocument(app);
    SwaggerModule.setup(`${prefix}/docs`, app, document, {
      jsonDocumentUrl: `${prefix}/openapi.json`,
    });
  }

  // Only the API expires upload sessions; the worker processes build AssetsService too.
  app.get(AssetsService).startExpiredSessionCleanup();

  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
}

void bootstrap();
