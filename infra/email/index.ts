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
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";

const resend = new Resend(env.RESEND_API_KEY);

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

  const { error } = await resend.emails.send({
    from: env.RESEND_FROM_ADDRESS,
    to,
    subject,
    html,
  });

  if (error) {
    console.error("[Email] Resend failed to send email", {
      to,
      subject,
      from: env.RESEND_FROM_ADDRESS,
      error,
    });

    throw new AppError(502, ERROR_CODES.EMAIL_SEND_FAILED, "Email could not be sent");
  }
}

/**
 * Escape a value for interpolation into email HTML.
 *
 * Workspace names are any 1-100 characters set by any signed-up user, and the
 * inviter name comes from a Clerk profile — both are attacker-controlled, and
 * both land in an email that passes SPF/DKIM as Trussen. Unescaped, a workspace
 * named `</strong><a href="https://evil.example">Verify your account</a>` turns
 * an invite into brand-backed phishing (F-22).
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sanitize a value for the Subject header.
 *
 * NOT HTML-escaped — a subject is plain text, so escaping would render a
 * literal `&amp;` to the recipient. CR/LF and other control characters are
 * stripped instead, because those are what let injected content forge
 * additional headers.
 */
export function sanitizeSubjectValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim();
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
  const inviteUrl = `${env.FRONTEND_URL}/invite?token=${encodeURIComponent(params.inviteToken)}`;
  const roleLabel = params.role.charAt(0) + params.role.slice(1).toLowerCase();

  // Escape once, here, so every interpolation below is safe by construction.
  const inviterName = escapeHtml(params.inviterName);
  const workspaceName = escapeHtml(params.workspaceName);
  const role = escapeHtml(roleLabel);

  await sendEmail({
    to: params.to,
    subject: sanitizeSubjectValue(
      `${params.inviterName} invited you to ${params.workspaceName} on Trussen`,
    ),
    html: renderEmailLayout({
      eyebrow: "You're invited",
      heading: `Join ${workspaceName} on Trussen`,
      bodyHtml: `
        <strong style="color: #14161f;">${inviterName}</strong> has invited you to collaborate
        in <strong style="color: #14161f;">${workspaceName}</strong> as
        a<span> </span><strong style="color: #14161f;">${role}</strong>.`,
      cta: { label: "Accept Invitation", url: inviteUrl },
      footnote: `This invitation expires in 7 days. If you don't have a Trussen account yet,
        you'll be asked to create one first.`,
      disclaimer: "If you weren't expecting this, you can safely ignore this email.",
    }),
  });
}

/**
 * Shared chrome for every transactional email (logo, card, footer).
 *
 * Every argument is inserted as raw HTML — callers pass values through
 * escapeHtml first (F-22). `accent` colours the eyebrow and the button.
 */
export function renderEmailLayout(params: {
  eyebrow: string;
  heading: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
  footnote?: string;
  disclaimer?: string;
  accent?: string;
}) {
  const accent = params.accent ?? "#5f72ea";

  return `
      <div style="margin: 0; padding: 32px 16px; background: #f4f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">
        <div style="max-width: 480px; margin: 0 auto;">
          <div style="text-align: center; margin-bottom: 24px;">
            <img src="https://project-management-assets-bucket.s3.ap-southeast-1.amazonaws.com/uploads/branding/Trussen-logo.png"
                 alt="Trussen" height="32" style="height: 32px; width: auto;" />
          </div>

          <div style="background: #ffffff; border-radius: 16px; padding: 40px 36px; box-shadow: 0 1px 3px rgba(20, 22, 31, 0.08);">
            <p style="margin: 0 0 4px; font-size: 13px; font-weight: 600; color: ${accent}; text-transform: uppercase; letter-spacing: 0.04em;">
              ${params.eyebrow}
            </p>
            <h1 style="margin: 0 0 16px; font-size: 22px; line-height: 1.35; color: #14161f;">
              ${params.heading}
            </h1>
            <div style="margin: 0 0 28px; font-size: 15px; line-height: 1.6; color: #555b6e;">
              ${params.bodyHtml}
            </div>
${params.cta ? `
            <a href="${params.cta.url}"
               style="display: block; text-align: center; padding: 13px 24px; background: ${accent};
                      color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600;
                      font-size: 15px;">
              ${params.cta.label}
            </a>
` : ""}${params.footnote ? `
            <p style="margin: 24px 0 0; font-size: 13px; line-height: 1.6; color: #8a8fa3;">
              ${params.footnote}
            </p>
` : ""}
          </div>

          <div style="text-align: center; margin-top: 28px;">
${params.disclaimer ? `
            <p style="margin: 0 0 8px; font-size: 12px; color: #9a9fb0;">
              ${params.disclaimer}
            </p>
` : ""}
            <p style="margin: 0; font-size: 12px; color: #9a9fb0;">
              <a href="mailto:hello@trussen.app" style="color: #9a9fb0; text-decoration: underline;">Contact support</a>
              &nbsp;&middot;&nbsp;
              <a href="${env.FRONTEND_URL}" style="color: #9a9fb0; text-decoration: underline;">trussen.app</a>
            </p>
            <p style="margin: 12px 0 0; font-size: 11px; color: #b7bacc;">
              &copy; ${new Date().getFullYear()} Trussen. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    `;
}
