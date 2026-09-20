import SwaggerParser from '@apidevtools/swagger-parser';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  const candidates = [
    resolve(process.cwd(), '../docs/openapi.yaml'),
    resolve(process.cwd(), 'openapi.yaml'),
  ];
  const paths = candidates.filter((path) => existsSync(path));
  if (paths.length === 0) {
    throw new Error('No OpenAPI document found');
  }
  for (const path of paths) {
    await SwaggerParser.validate(path);
    console.log(`OpenAPI document is valid: ${path}`);
  }
}

void main();
