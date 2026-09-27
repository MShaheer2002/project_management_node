/**
 * Backfill: re-check every user's stored email against Clerk (N-02).
 *
 * Before N-02 the first email on the Clerk account was stored, verified or
 * not, and invitations trust that stored email. This re-reads each active
 * user from Clerk and stores their verified email instead (verifiedEmailOf).
 * Safe to run twice. Needs CLERK_SECRET_KEY.
 *
 *   npx tsx workers/resync-user-emails.ts          # report only
 *   npx tsx workers/resync-user-emails.ts --apply  # write
 */

import { clerkClient } from "@clerk/express";
import { prisma } from "../shared/utils/prisma.js";
import { verifiedEmailOf } from "../modules/auth/auth.service.js";

async function main() {
  const apply = process.argv.includes("--apply");
  const users = await prisma.user.findMany({ where: { deletedAt: null }, select: { id: true, email: true } });

  const changes: Array<{ id: string; from: string; to: string }> = [];
  for (const user of users) {
    let clerkUser;
    try {
      clerkUser = await clerkClient.users.getUser(user.id);
    } catch {
      console.log(`  ${user.id}: not found in Clerk, skipped`);
      continue;
    }
    const email = verifiedEmailOf({
      id: clerkUser.id,
      first_name: null,
      last_name: null,
      image_url: null,
      primary_email_address_id: clerkUser.primaryEmailAddressId,
      email_addresses: clerkUser.emailAddresses.map((e) => ({
        id: e.id,
        email_address: e.emailAddress,
        verification: e.verification ? { status: e.verification.status } : null,
      })),
    });
    if (email !== user.email) changes.push({ id: user.id, from: user.email, to: email });
  }

  console.log(`${users.length} user(s) checked; ${changes.length} stored email(s) not verified.`);
  for (const change of changes) console.log(`  ${change.id}: ${change.from} -> ${change.to}`);

  if (!apply) {
    console.log(changes.length ? "\nDry run. Re-run with --apply to fix." : "\nNothing to do.");
    return;
  }

  for (const change of changes) {
    try {
      await prisma.user.update({ where: { id: change.id }, data: { email: change.to } });
    } catch {
      // Unique email: another row already has it. Leave it for a person to look at.
      console.log(`  ${change.id}: ${change.to} is used by another user, skipped`);
    }
  }
  console.log(`\nDone.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
