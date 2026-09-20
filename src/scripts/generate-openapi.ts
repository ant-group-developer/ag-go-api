import { NestFactory } from '@nestjs/core';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import prettier from 'prettier';
import { stringify } from 'yaml';
import { AppModule } from '../app.module';
import { createOpenApiDocument } from '../openapi';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const document = createOpenApiDocument(app);
  const prettierConfig = (await prettier.resolveConfig(process.cwd())) ?? {};
  const output = await prettier.format(stringify(document), {
    ...prettierConfig,
    parser: 'yaml',
  });
  await fs.writeFile(resolve(process.cwd(), 'openapi.yaml'), output, 'utf8');
  try {
    await fs.mkdir(resolve(process.cwd(), '../docs'), { recursive: true });
    await fs.writeFile(resolve(process.cwd(), '../docs/openapi.yaml'), output, 'utf8');
  } catch {
    // The standalone API repository does not always have the workspace docs folder.
  }
  await app.close();
}

void main();
