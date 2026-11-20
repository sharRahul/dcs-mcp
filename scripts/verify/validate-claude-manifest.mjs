/** Validate our bundle against the pinned, unmodified upstream MCPB 0.4 schema. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bytes = readFileSync(path.join(root, 'vendor/mcpb/manifest-v0.4.schema.json'));
if (createHash('sha256').update(bytes).digest('hex') !== '068557824c651d6d49b86ad132adeafe62ca788d918b3e1e2b224bf0f91320fd') {
  throw new Error('Pinned MCPB manifest schema hash mismatch');
}
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(bytes));
const manifest = JSON.parse(readFileSync(path.resolve(process.argv[2] ?? path.join(root, 'plugins/dcs-claude-desktop/manifest.json')), 'utf8'));
if (!validate(manifest)) {
  console.error(ajv.errorsText(validate.errors, { separator: '\n' }));
  process.exitCode = 1;
} else console.log('Manifest schema validation passes (pinned upstream MCPB 0.4 schema).');
