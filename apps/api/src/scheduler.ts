import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { HOLD_REASONS, SYSTEM_USER_ID, zonedClock } from '@opennjob/core';
import type { Application } from '@opennjob/core';
import { ApplyingService } from './applying.service';
import { DEPS } from './deps';
import type { OpennJobDeps } from './deps';
import { OpennJobService } from './services';

/**
 * The daily jobs, on Europe/London time (NFR-10), safe with more than one API instance:
 *
 *   06:00  discovery: refresh the catalogue from the sources, then prepare drafts for every
 *          active account inside that person's own scope (DIS-4)
 *   09:00  each person's report: submitted with receipts, held and why, new matches, failures,
 *          and "nothing happened" on a quiet day (REP-1, REP-2). No CV text, statement or
 *          declaration content is ever in it (REP-3). The person can pause it (REP-4).
 *   03:00  retention: records older than OPENNJOB_RETENTION_DAYS are deleted (DP-5)
 *
 * Each job runs once per London day: a claim in the database decides which instance does it.
 * A failed discovery, agent run or report raises an operator alert at once (NFR-4).
 */
@Injectable()
export class Scheduler implements OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DEPS) private readonly deps: OpennJobDeps,
    @Inject(OpennJobService) private readonly service: OpennJobService,
    @Inject(ApplyingService) private readonly applying: ApplyingService,
  ) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private now(): string {
    return this.deps.clock().toISOString();
  }

  private async alert(key: string, subject: string, text: string): Promise<void> {
    const hour = this.now().slice(0, 13);
    if (!(await this.deps.repository.claimOnce(`alert:${key}:${hour}`, this.now()))) return; // one per problem per hour
    await this.deps.notifier?.alertOperator(subject, text);
    await this.deps.eventBus.publish({ id: this.deps.newId(), type: 'operator.alerted', userId: SYSTEM_USER_ID, occurredAt: this.now(), payload: { key } });
  }

  /** One pass. Returns what ran, for tests and the log. */
  async tick(): Promise<string[]> {
    const ran: string[] = [];
    const { date, hour } = zonedClock(this.deps.clock());
    if (hour >= 3 && this.deps.config.retentionDays && (await this.deps.repository.claimOnce(`retention:${date}`, this.now()))) {
      await this.retention(); ran.push('retention');
    }
    if (hour >= 6 && (await this.deps.repository.claimOnce(`discovery:${date}`, this.now()))) {
      await this.discovery(); ran.push('discovery');
    }
    if (hour >= 9) {
      for (const userId of await this.deps.repository.listUserIds()) {
        if (await this.deps.repository.claimOnce(`report:${userId}:${date}`, this.now())) {
          await this.report(userId); ran.push(`report:${userId}`);
        }
      }
    }
    return ran;
  }

  async retention(): Promise<Record<string, number>> {
    const days = this.deps.config.retentionDays as number;
    const cutoff = new Date(this.deps.clock().getTime() - days * 86_400_000).toISOString();
    const counts = await this.deps.repository.purgeBefore(cutoff);
    await this.deps.eventBus.publish({ id: this.deps.newId(), type: 'retention.purged', userId: SYSTEM_USER_ID, occurredAt: this.now(), payload: { days, ...counts } });
    return counts;
  }

  async discovery(): Promise<void> {
    try {
      const summary = await this.service.refreshJobs(SYSTEM_USER_ID);
      if (summary.errors.length > 0) {
        await this.alert('discovery-sources', 'Job sources failed', `${summary.errors.length} job source(s) failed during the daily discovery: ${summary.errors.map((e: { source: string }) => e.source).join(', ')}.`);
      }
    } catch (err) {
      await this.alert('discovery', 'Daily discovery failed', `The daily discovery stopped: ${err instanceof Error ? err.name : 'Error'}.`);
      return;
    }
    for (const userId of await this.deps.repository.listUserIds()) {
      if (!(await this.deps.repository.getProfile(userId))) continue; // not active yet: no profile, no scope
      try {
        const auth = await this.applying.getAuthorisation(userId);
        await this.service.runAgent(userId, { mode: auth.enabled ? 'auto' : 'hybrid' });
        // Applications by e-mail go out under the same authorisation and checks as the queue.
        if (auth.enabled) await this.applying.sendByEmail(userId);
      } catch (err) {
        await this.alert(`agent-run:${userId}`, 'Agent run failed', `The daily agent run failed for one account: ${err instanceof Error ? err.name : 'Error'}.`);
      }
    }
  }

  /** The text of a report. Names job titles, employers, statuses and reasons; never CV text, statements or declarations. */
  async reportText(userId: string, since: string, until: string): Promise<{ text: string; html: string; counts: Record<string, number> }> {
    const apps = await this.deps.repository.listApplications(userId);
    const events = (await this.deps.repository.listEvents(userId)).filter((e) => e.occurredAt >= since && e.occurredAt < until);
    const byId = new Map(apps.map((a) => [a.id, a]));
    const ids = (type: string) => [...new Set(events.filter((e) => e.type === type).map((e) => e.payload.applicationId as string))].map((id) => byId.get(id)).filter((a): a is Application => Boolean(a));
    const submitted = ids('application.submitted');
    const held = apps.filter((a) => a.status === 'needs_you');
    const uncertain = apps.filter((a) => a.status === 'uncertain');
    const drafted = ids('application.drafted');
    // The daily discovery runs for the whole platform, so its failures are logged against no account.
    const system = (await this.deps.repository.listEvents(SYSTEM_USER_ID)).filter((e) => e.occurredAt >= since && e.occurredAt < until);
    const failures = [...events, ...system].filter((e) => e.type === 'jobs.refreshed' && Number(e.payload.sourceErrors) > 0).length;
    const reason = (r: string) => (HOLD_REASONS as Record<string, string>)[r] ?? (r.startsWith('question:') ? `A question with no stored answer: ${r.slice(9)}` : r.startsWith('sensitive:') ? `A ${r.slice(10)} question that only you answer` : r);
    const lines: string[] = [];
    lines.push(`Since ${since.slice(0, 16).replace('T', ' ')} UTC.`, '');
    lines.push(`Submitted, with the site's confirmation: ${submitted.length}`);
    for (const a of submitted) lines.push(`  • ${a.jobTitle} — ${a.employer}${a.receipt ? ` · confirmation: "${a.receipt.confirmationText.slice(0, 160)}"` : ''}`);
    lines.push(`Held for you: ${held.length}`);
    for (const a of held) lines.push(`  • ${a.jobTitle} — ${a.employer}: ${(a.holdReasons ?? []).map(reason).join('; ') || 'needs you'}`);
    if (uncertain.length) {
      lines.push(`No confirmation seen (check before anything else): ${uncertain.length}`);
      for (const a of uncertain) lines.push(`  • ${a.jobTitle} — ${a.employer}`);
    }
    lines.push(`New matches prepared: ${drafted.length}`);
    for (const a of drafted) lines.push(`  • ${a.jobTitle} — ${a.employer} (${a.score}%)`);
    lines.push(`Problems: ${failures ? `${failures} discovery run(s) with a failed source` : 'none'}`);
    if (!submitted.length && !held.length && !drafted.length && !uncertain.length && !failures) lines.push('', 'Nothing happened since your last report.');
    const text = lines.join('\n');
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
    const html = `<pre style="font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap">${esc(text)}</pre>`;
    return { text, html, counts: { submitted: submitted.length, held: held.length, uncertain: uncertain.length, matches: drafted.length, failures } };
  }

  async report(userId: string): Promise<void> {
    const key = `report.watermark.${userId}`;
    const until = this.now();
    const since = (await this.deps.repository.getPlatformSetting<string>(key)) ?? new Date(this.deps.clock().getTime() - 86_400_000).toISOString();
    try {
      const { text, html, counts } = await this.reportText(userId, since, until);
      const deliveries = (await this.deps.notifier?.sendDirect(userId, 'agent.daily_report', { text, html })) ?? [];
      if (deliveries.some((d) => d.channel === 'email' && d.status === 'failed')) {
        await this.alert('report-email', 'Report e-mail failed', 'A daily report e-mail could not be sent.');
      }
      await this.deps.repository.setPlatformSetting(key, until);
      await this.deps.eventBus.publish({ id: this.deps.newId(), type: 'report.daily', userId, occurredAt: until, payload: counts });
    } catch (err) {
      await this.alert('report', 'Daily report failed', `A daily report could not be built: ${err instanceof Error ? err.name : 'Error'}.`);
    }
  }
}
