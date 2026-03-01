/**
 * Validator-Janitor: run batch verification and programmatic correction for a document.
 * Usage: npx ts-node src/scripts/validator-janitor.ts <documentId> [--dry-run=false]
 *
 * Requires DATABASE_URL. Loads document + DNA, applies cleaner + validator, outputs JSON report.
 * With --dry-run=false (default is true) writes corrected segment text back to DB.
 */

import { runValidatorJanitor } from '../services/validatorJanitor';

async function main() {
  const args = process.argv.slice(2);
  const documentId = args.find((a) => !a.startsWith('--'));
  const dryRunArg = args.find((a) => a.startsWith('--dry-run'));
  const dryRun = dryRunArg === '--dry-run=false' ? false : true;

  if (!documentId) {
    console.error('Usage: npx ts-node src/scripts/validator-janitor.ts <documentId> [--dry-run=false]');
    process.exit(1);
  }

  const report = await runValidatorJanitor(documentId, { dryRun });
  console.log(JSON.stringify(report, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
