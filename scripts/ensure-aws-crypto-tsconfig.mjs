/**
 * @aws-crypto/* packages ship tsconfig.json files that extend "../tsconfig.json"
 * under @aws-crypto/, but npm does not always publish that parent file — IDEs/tsc
 * then error: "Cannot read file .../@aws-crypto/tsconfig.json".
 * Create a minimal base if missing (safe no-op if already present).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');
const target = path.join(backendRoot, 'node_modules', '@aws-crypto', 'tsconfig.json');
const dir = path.dirname(target);

const minimal = `{
  "compilerOptions": {
    "target": "ES2018",
    "module": "commonjs",
    "declaration": true,
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  }
}
`;

try {
  if (!fs.existsSync(dir)) process.exit(0);
  if (fs.existsSync(target)) process.exit(0);
  fs.writeFileSync(target, minimal, 'utf8');
  console.log('[ensure-aws-crypto-tsconfig] Wrote node_modules/@aws-crypto/tsconfig.json');
} catch (e) {
  console.warn('[ensure-aws-crypto-tsconfig]', e?.message || e);
}
