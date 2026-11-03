import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_TEMPLATES, INTERIM_TEMPLATE_NOTE } from '../modules/documents/default-templates';

/**
 * Writes the interim contract / amendment / acceptance templates (Q-R9) to templates/documents/,
 * for business to open in Word and standardise. `POST /contract-templates/install-defaults` installs
 * the same files in AG Go.
 */
async function main(): Promise<void> {
  const directory = resolve(process.cwd(), 'templates/documents');
  await fs.mkdir(directory, { recursive: true });
  for (const template of DEFAULT_TEMPLATES) {
    await fs.writeFile(resolve(directory, template.fileName), template.build());
    console.log(`${template.fileName}: ${template.name}`);
  }
  console.log(INTERIM_TEMPLATE_NOTE);
}

void main();
