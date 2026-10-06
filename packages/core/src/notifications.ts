/**
 * The communication catalogue: one event engine, many channels.
 *
 * Every notification OpennJob can send is one entry here. `trigger` names the domain event
 * (see EventBus) that fires it; `trigger: null` marks an entry whose feature is not built yet
 * (billing, password reset, interview invitations...). Those are listed so the catalogue shows
 * the whole plan, and they are counted as planned, never as live.
 *
 * Content rules: a message names at most the job title, the employer and counts. It never
 * carries CV text, passport values, statements, declarations or contact details.
 */

export type Channel = 'email' | 'inapp' | 'sms' | 'push' | 'whatsapp';
export const CHANNELS: readonly Channel[] = ['email', 'inapp', 'sms', 'push', 'whatsapp'];
export type Severity = 'info' | 'success' | 'warning' | 'critical';

export interface NotificationEventDef {
  key: string;
  category: string;
  name: string;
  /** Subject or title. Placeholders: {{jobTitle}} {{employer}} {{count}} {{threshold}} {{app}} */
  subject: string;
  body: string;
  severity: Severity;
  /** Default channels. In-app is always included. */
  channels: Channel[];
  /** Mandatory notices go out on their default channels whatever the user's opt-outs. */
  mandatory?: boolean;
  /** The domain event that fires it, or null when the feature is not built yet. */
  trigger: string | null;
  /**
   * Sent directly by the code that has the content (a one-time link, the daily report), never by
   * the event dispatcher and never copied into the in-app inbox, so no token is ever stored.
   */
  direct?: boolean;
}

export const NOTIFICATION_CATEGORIES = [
  'Account and access',
  'Sign-in and security',
  'Profile and passport',
  'Jobs and matching',
  'AI agent',
  'Applications',
  'Interview preparation',
  'Privacy and legal',
  'Plans and billing',
  'Platform',
] as const;

type Row = [key: string, category: number, name: string, subject: string, body: string, severity: Severity, channels: Channel[], trigger: string | null, mandatory?: boolean, direct?: boolean];

const ROWS: Row[] = [
  // Account and access
  ['account.registered', 0, 'Account created', 'Welcome to {{app}}', 'Your account is ready. Add your CV and credential passport to see your matches.', 'success', ['email', 'inapp'], 'account.registered'],
  ['account.pilot_invitation', 0, 'Pilot invitation', 'You are invited to the {{app}} pilot', 'You have been invited to try {{app}}. Create your account with this email address.', 'info', ['email'], null],
  ['account.email_verification_required', 0, 'Email verification required', 'Verify your email address', 'Confirm this address before {{app}} sends any application for you. The link expires in 24 hours.', 'warning', ['email'], 'auth.verification_sent', true, true],
  ['account.email_verified', 0, 'Email verified', 'Email address verified', 'Your email address is confirmed.', 'success', ['inapp'], 'account.email_verified'],
  ['account.signed_in', 0, 'New sign-in', 'New sign-in to your {{app}} account', 'Your account was signed in to. If this was not you, change your password and contact support.', 'info', ['inapp'], 'account.signed_in'],
  ['account.test', 0, 'Test message', 'Test message from {{app}}', 'This is a test of your notification channels. No action is needed.', 'info', ['email', 'inapp', 'sms', 'push', 'whatsapp'], 'notification.test'],
  // Sign-in and security
  ['security.too_many_attempts', 1, 'Too many sign-in attempts', 'Too many sign-in attempts on your account', 'Sign-in was paused after repeated failed attempts.', 'warning', ['email', 'inapp'], null, true],
  ['security.password_reset_link', 1, 'Password reset link', 'Reset your {{app}} password', 'Use the link to choose a new password. It expires in one hour. If you did not ask for it, ignore this message.', 'info', ['email'], 'auth.password_reset_requested', true, true],
  ['security.password_changed', 1, 'Password changed', 'Your password was changed', 'Every other session was signed out. If you did not change it, contact support at once.', 'warning', ['email', 'inapp', 'sms'], 'account.password_changed', true],
  ['security.mfa_code', 1, 'Verification code', 'Your {{app}} verification code', 'Enter the code to finish signing in.', 'info', ['sms', 'email'], null, true],
  // Profile and passport
  ['profile.saved', 2, 'Profile saved', 'Profile saved', 'Your matches now use your updated profile.', 'success', ['inapp'], 'profile.updated'],
  ['passport.saved', 2, 'Passport saved', 'Credential passport saved', 'Your credential passport was updated.', 'success', ['inapp'], 'passport.updated'],
  ['passport.training_expiring', 2, 'Training expiring', 'Training expires soon', 'A training record in your passport expires within 30 days. Renew it before you apply.', 'warning', ['email', 'inapp', 'push'], null],
  ['passport.training_expired', 2, 'Training expired', 'Training has expired', 'A training record in your passport has expired.', 'warning', ['email', 'inapp'], null],
  // Jobs and matching
  ['jobs.catalogue_refreshed', 3, 'Job catalogue refreshed', 'Jobs refreshed: {{count}} in the catalogue', 'OpennJob looked for jobs again. Open Matches to see how they score.', 'info', ['inapp'], 'jobs.refreshed'],
  ['jobs.new_strong_matches', 3, 'New strong matches', '{{count}} new matches at {{threshold}}% or more', 'New jobs score at or above your threshold.', 'success', ['email', 'inapp', 'push'], null],
  ['jobs.source_failed', 3, 'Job source failed', 'A job source could not be read', 'One of the job sources failed. Matches from it may be missing.', 'warning', ['inapp'], null],
  // AI agent
  ['agent.run_completed', 4, 'Agent run finished', 'Agent run finished: {{count}} applications prepared', 'Every prepared application waits for your review. Nothing has been sent to any employer.', 'success', ['email', 'inapp', 'push'], 'agent.run'],
  ['agent.review_needed', 4, 'Your review is needed', 'Action needed: review {{jobTitle}}', 'A draft for {{jobTitle}} at {{employer}} waits for you. Only you confirm the declarations.', 'warning', ['inapp', 'push'], 'application.drafted'],
  ['agent.uncertain_attempt', 4, 'Uncertain attempt', 'Check whether {{jobTitle}} was submitted', 'The page changed before a receipt appeared. Check with the employer before trying again.', 'critical', ['email', 'inapp', 'sms'], 'application.uncertain', true],
  ['agent.held_for_you', 4, 'Held for you', '{{jobTitle}} needs you', 'The agent filled what it may for {{employer}}. A declaration, a question or a check is yours to do.', 'warning', ['email', 'inapp', 'push'], 'application.needs_you'],
  ['agent.daily_report', 4, 'Daily report', 'Your {{app}} report', 'What was sent, what is held for you and why, new matches and any failures, since the last report.', 'info', ['email'], 'report.daily', false, true],
  // Applications
  ['application.approved', 5, 'Application approved', 'Approved: {{jobTitle}}', 'Nothing has been sent yet. Fill the form with the extension and submit it yourself.', 'success', ['inapp'], 'application.confirmed'],
  ['application.submitted', 5, 'Application submitted', 'Recorded as submitted: {{jobTitle}}', 'You recorded the application to {{employer}} as submitted.', 'success', ['email', 'inapp'], 'application.submitted'],
  ['application.statement_saved', 5, 'Statement saved', 'Statement saved: {{jobTitle}}', 'Your edited statement is the one the extension fills.', 'info', ['inapp'], 'application.statement.edited'],
  ['application.closing_soon', 5, 'Closing soon', '{{jobTitle}} closes soon', 'A job you prepared closes within two days.', 'warning', ['email', 'inapp', 'push'], null],
  ['application.recruiter_reply', 5, 'Recruiter reply', 'Reply from {{employer}}', 'A recruiter replied about {{jobTitle}}.', 'success', ['email', 'inapp', 'push'], null],
  ['application.interview_invited', 5, 'Interview invitation', 'Interview invitation: {{jobTitle}}', '{{employer}} invited you to interview.', 'success', ['email', 'inapp', 'push', 'sms', 'whatsapp'], null],
  // Interview preparation
  ['interview.feedback_ready', 6, 'Practice feedback ready', 'Your practice feedback is ready', 'Open Interview to read your STAR feedback.', 'info', ['inapp'], 'interview.feedback'],
  ['interview.reminder', 6, 'Interview reminder', 'Reminder: interview for {{jobTitle}}', 'Your interview is coming up. Practise with the questions for this role.', 'info', ['email', 'push', 'sms', 'whatsapp'], null],
  // Privacy and legal
  ['privacy.data_export_ready', 7, 'Data export ready', 'Your data export is ready', 'You downloaded a copy of everything {{app}} holds about you.', 'success', ['inapp'], 'account.exported'],
  ['privacy.account_deleted', 7, 'Account deleted', 'Your {{app}} account has been deleted', 'Your account and everything stored for it were deleted.', 'info', ['email'], 'account.deleted', true],
  ['privacy.terms_updated', 7, 'Terms updated', 'We have updated our terms', 'Please read and accept the updated terms to keep using {{app}}.', 'info', ['email', 'inapp'], null, true],
  // Plans and billing (not built)
  ['billing.trial_started', 8, 'Trial started', 'Your {{app}} trial has started', 'Your trial is active.', 'success', ['email', 'inapp'], null],
  ['billing.payment_failed', 8, 'Payment failed', 'Your payment failed', 'Update your payment details to keep your plan.', 'warning', ['email', 'inapp', 'sms'], null, true],
  ['billing.invoice_ready', 8, 'Invoice ready', 'Your invoice is ready', 'A new invoice is available.', 'info', ['email', 'inapp'], null],
  // Platform
  ['platform.maintenance_scheduled', 9, 'Scheduled maintenance', 'Scheduled maintenance', '{{app}} will be briefly unavailable for maintenance.', 'info', ['email', 'inapp'], null],
  ['platform.outage', 9, 'Service disruption', 'Service disruption', '{{app}} is having problems. We are working on it.', 'critical', ['email', 'inapp', 'sms'], null, true],
  ['platform.service_restored', 9, 'Service restored', 'Service restored', '{{app}} is working normally again.', 'success', ['email', 'inapp'], null],
];

export const NOTIFICATION_CATALOGUE: readonly NotificationEventDef[] = ROWS.map(([key, category, name, subject, body, severity, channels, trigger, mandatory, direct]) => ({
  key,
  category: NOTIFICATION_CATEGORIES[category] as string,
  name,
  subject,
  body,
  severity,
  channels: channels.includes('inapp') || channels.length === 0 ? channels : ['inapp', ...channels],
  trigger,
  ...(mandatory ? { mandatory: true } : {}),
  ...(direct ? { direct: true } : {}),
}));

export function notificationEvent(key: string): NotificationEventDef | undefined {
  return NOTIFICATION_CATALOGUE.find((e) => e.key === key);
}

/** The catalogue entries fired by one domain event type. */
export function eventsForTrigger(type: string): NotificationEventDef[] {
  return NOTIFICATION_CATALOGUE.filter((e) => e.trigger === type && !e.direct);
}

/** Only these placeholders exist. Anything else in a template renders as nothing. */
export interface NotificationVars {
  app?: string;
  jobTitle?: string;
  employer?: string;
  count?: number;
  threshold?: number;
}

export function renderTemplate(template: string, vars: NotificationVars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const v = (vars as Record<string, unknown>)[name];
    return v === undefined || v === null ? '' : String(v);
  });
}

export interface NotificationPreferences {
  /** In-app is always on. */
  email: boolean;
  sms: boolean;
  push: boolean;
  whatsapp: boolean;
  /** Catalogue keys the user turned off. Ignored for mandatory notices. */
  muted: string[];
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = { email: true, sms: false, push: false, whatsapp: false, muted: [] };

/** Which channels one event goes to for one user, and which were skipped because the user opted out. */
export function routeChannels(event: NotificationEventDef, prefs: NotificationPreferences): { send: Channel[]; skipped: Channel[] } {
  if (event.mandatory) return { send: [...event.channels], skipped: [] };
  if (prefs.muted.includes(event.key)) return { send: event.channels.filter((c) => c === 'inapp'), skipped: event.channels.filter((c) => c !== 'inapp') };
  const send = event.channels.filter((c) => c === 'inapp' || prefs[c]);
  return { send, skipped: event.channels.filter((c) => !send.includes(c)) };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export interface Brand {
  name: string;
  colour: string;
  footer: string;
  appUrl?: string;
}

/** The branded e-mail. Plain table layout, inline styles, no images, no tracking. */
export function renderEmailHtml(event: NotificationEventDef, vars: NotificationVars, brand: Brand): { subject: string; text: string; html: string } {
  const v = { ...vars, app: brand.name };
  const subject = renderTemplate(event.subject, v);
  const body = renderTemplate(event.body, v);
  const colour = /^#[0-9a-fA-F]{6}$/.test(brand.colour) ? brand.colour : '#1A3C8A';
  const link = brand.appUrl && /^https?:\/\//.test(brand.appUrl) ? `<p style="margin:24px 0 0"><a href="${escapeHtml(brand.appUrl)}" style="background:${colour};color:#04201B;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open ${escapeHtml(brand.name)}</a></p>` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#F2F6F5;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#12211E"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #D7E1DE;border-radius:12px"><tr><td style="padding:18px 24px;border-bottom:4px solid ${colour}"><span style="font-size:22px;font-weight:700;letter-spacing:-.02em">${escapeHtml(brand.name)}</span></td></tr><tr><td style="padding:24px"><h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(subject)}</h1><p style="margin:0;line-height:1.5">${escapeHtml(body)}</p>${link}</td></tr><tr><td style="padding:16px 24px;border-top:1px solid #D7E1DE;font-size:12px;color:#566964">${escapeHtml(brand.footer)}${event.mandatory ? '<br>This is a service notice: it is sent even if you turned off optional messages.' : '<br>You can change which messages you receive in Notifications, Settings.'}</td></tr></table></td></tr></table></body></html>`;
  const text = `${subject}\n\n${body}\n\n${brand.footer}`;
  return { subject, text, html };
}
