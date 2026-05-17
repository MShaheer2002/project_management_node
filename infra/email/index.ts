/**
 * Email Service — Resend
 *
 * Sends transactional emails (workspace invitations, notifications, etc.).
 * Uses Resend (https://resend.com) for delivery.
 *
 * In development with a placeholder API key, emails are logged to console
 * instead of being sent. In production, they go through Resend's API.
 */

import { Resend } from "resend";
import { env } from "../../config/env.js";

const resend = new Resend(env.RESEND_API_KEY);

// "From" address — must be verified in Resend dashboard for production
// In development with onboarding@resend.dev, Resend allows sending to your own email
const FROM_ADDRESS = "Linearis <onboarding@resend.dev>";

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

/**
 * Send an email via Resend.
 * In development with placeholder key, logs to console instead of sending.
 */
export async function sendEmail({ to, subject, html }: SendEmailParams) {
  // If using placeholder key, log instead of sending (development convenience)
  if (env.RESEND_API_KEY === "re_placeholder") {
    console.log(`📧 [DEV] Email to: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Body: ${html.slice(0, 200)}...`);
    return;
  }

  await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject,
    html,
  });
}

/**
 * Send a workspace invitation email.
 * Contains the invite link with the raw token + workspace/role context.
 */
export async function sendInvitationEmail(params: {
  to: string;
  inviterName: string;
  workspaceName: string;
  role: string;
  inviteToken: string;
}) {
  const inviteUrl = `${env.FRONTEND_URL}/invite?token=${params.inviteToken}`;

  await sendEmail({
    to: params.to,
    subject: `You've been invited to ${params.workspaceName} on Linearis`,
    html: `
      <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
        <h2>You're invited!</h2>
        <p>
          <strong>${params.inviterName}</strong> invited you to join
          <strong>${params.workspaceName}</strong> as a <strong>${params.role}</strong>.
        </p>
        <p>
          <a href="${inviteUrl}"
             style="display: inline-block; padding: 12px 24px; background: #6366f1;
                    color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Accept Invitation
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">
          This invitation expires in 7 days. If you don't have a Linearis account,
          you'll be asked to create one first.
        </p>
        <p style="color: #999; font-size: 12px;">
          If you didn't expect this invitation, you can safely ignore this email.
        </p>
      </div>
    `,
  });
}
