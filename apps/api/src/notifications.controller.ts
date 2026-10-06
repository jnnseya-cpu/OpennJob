import { Body, Controller, Get, HttpCode, Inject, Post, Put, Query } from '@nestjs/common';
import { CHANNELS, NOTIFICATION_CATALOGUE, NOTIFICATION_CATEGORIES, notificationEvent, renderEmailHtml } from '@opennjob/core';
import type { NotificationPreferences } from '@opennjob/core';
import { CurrentUser } from './auth.guard';
import { DEPS } from './deps';
import type { OpennJobDeps } from './deps';
import { Notifier, SAMPLE_VARS, wiredChannels } from './notifications';
import { ZodPipe, markReadSchema, notificationPreferencesSchema, notificationPreviewSchema, notificationTestSchema } from './schemas';

/** The signed-in user's notifications, preferences and delivery log, and the catalogue for template QA. */
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(DEPS) private readonly deps: OpennJobDeps) {}

  private get notifier(): Notifier {
    return this.deps.notifier ?? new Notifier(this.deps);
  }

  @Get()
  async inbox(@CurrentUser() userId: string) {
    const items = await this.deps.repository.listNotifications(userId, 200);
    return { unread: items.filter((n) => !n.readAt).length, items };
  }

  @Post('read')
  @HttpCode(200)
  async read(@CurrentUser() userId: string, @Body(new ZodPipe(markReadSchema)) body: { ids?: string[] }) {
    return { changed: await this.deps.repository.markNotificationsRead(userId, body.ids, this.deps.clock().toISOString()) };
  }

  @Get('preferences')
  preferences(@CurrentUser() userId: string) {
    return this.notifier.preferences(userId);
  }

  @Put('preferences')
  async savePreferences(@CurrentUser() userId: string, @Body(new ZodPipe(notificationPreferencesSchema)) body: NotificationPreferences) {
    await this.deps.repository.saveNotificationPreferences(userId, body);
    return body;
  }

  @Get('deliveries')
  async deliveries(@CurrentUser() userId: string) {
    const items = await this.deps.repository.listDeliveries(userId, 500);
    const byChannel = Object.fromEntries(CHANNELS.map((c) => [c, items.filter((d) => d.channel === c).length]));
    const byStatus = Object.fromEntries(['delivered', 'sent', 'logged', 'skipped', 'failed'].map((s) => [s, items.filter((d) => d.status === s).length]));
    return { items: items.slice(0, 100), summary: { total: items.length, byChannel, byStatus } };
  }

  /** The catalogue. Not personal: every user sees the same list. */
  @Get('catalogue')
  catalogue() {
    const wired = wiredChannels(this.notifier.sender);
    return {
      categories: NOTIFICATION_CATEGORIES,
      events: NOTIFICATION_CATALOGUE.map((e) => ({ ...e, live: e.trigger !== null })),
      channels: CHANNELS.map((c) => ({ channel: c, wired: wired[c], provider: c === 'email' ? this.notifier.sender.name : c === 'inapp' ? 'inbox' : 'not wired', events: NOTIFICATION_CATALOGUE.filter((e) => e.channels.includes(c)).length })),
      stats: {
        events: NOTIFICATION_CATALOGUE.length,
        categories: NOTIFICATION_CATEGORIES.length,
        mandatory: NOTIFICATION_CATALOGUE.filter((e) => e.mandatory).length,
        live: NOTIFICATION_CATALOGUE.filter((e) => e.trigger !== null).length,
        planned: NOTIFICATION_CATALOGUE.filter((e) => e.trigger === null).length,
      },
    };
  }

  /** The branded e-mail exactly as sent, with sample values (no personal data). */
  @Get('preview')
  preview(@Query(new ZodPipe(notificationPreviewSchema)) query: { event: string }) {
    const def = notificationEvent(query.event);
    if (!def) return { subject: '', text: '', html: '' };
    return renderEmailHtml(def, SAMPLE_VARS, this.notifier.brand);
  }

  /** Fires one catalogue event to the caller on every channel it would use. Sandbox unless a provider is configured. */
  @Post('test')
  @HttpCode(200)
  async test(@CurrentUser() userId: string, @Body(new ZodPipe(notificationTestSchema)) body: { event: string }) {
    const def = notificationEvent(body.event);
    if (!def) return { deliveries: [] };
    return { deliveries: await this.notifier.dispatch(userId, def, SAMPLE_VARS, { test: true }) };
  }
}
