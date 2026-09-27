/**
 * Backfill: encrypt Integration.accessToken rows written before F-15.
 *
 * Reads are tolerant of plaintext (decryptSecretOrLegacy), so this is safe to
 * run at any time and safe to run twice — already-encrypted rows are skipped.
 * Until it runs, pre-existing GitHub/Slack/Figma tokens remain plaintext at rest.
 *
 *   npx tsx workers/encrypt-integration-tokens.ts          # report only
 *   npx tsx workers/encrypt-integration-tokens.ts --apply  # write
 */

import { prisma } from "../shared/utils/prisma.js";
import { encryptSecret, isEncryptedSecret } from "../shared/utils/secret-box.js";

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = await prisma.integration.findMany({
    where: { accessToken: { not: null } },
    select: { id: true, provider: true, workspaceId: true, accessToken: true },
  });

  const plaintext = rows.filter((row) => !isEncryptedSecret(row.accessToken!));

  console.log(`${rows.length} integration(s) with a token; ${plaintext.length} still plaintext.`);
  for (const row of plaintext) {
    console.log(`  ${row.provider} workspace=${row.workspaceId}`);
  }

  if (!apply) {
    console.log(plaintext.length ? "\nDry run. Re-run with --apply to encrypt." : "\nNothing to do.");
    return;
  }

  for (const row of plaintext) {
    await prisma.integration.update({
      where: { id: row.id },
      data: { accessToken: encryptSecret(row.accessToken!) },
    });
  }
  console.log(`\nEncrypted ${plaintext.length} token(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
