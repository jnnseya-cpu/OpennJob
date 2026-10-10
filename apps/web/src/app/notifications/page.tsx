'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../components/AppShell';
import { BarList, StatTiles } from '../../components/Charts';
import { api, errorText } from '../../lib/api';

type Channel = 'email' | 'inapp' | 'sms' | 'push' | 'whatsapp';
interface Note {
  id: string;
  eventKey: string;
  category: string;
  severity: 'info' | 'success' | 'warning' | 'critical';
  subject: string;
  body: string;
  createdAt: string;
  readAt?: string;
}
interface Prefs {
  email: boolean;
  sms: boolean;
  push: boolean;
  whatsapp: boolean;
  muted: string[];
}
interface CatalogueEvent {
  key: string;
  category: string;
  name: string;
  subject: string;
  severity: Note['severity'];
  channels: Channel[];
  mandatory?: boolean;
  live: boolean;
}
interface Catalogue {
  categories: string[];
  events: CatalogueEvent[];
  channels: { channel: Channel; wired: boolean; provider: string; events: number }[];
  stats: { events: number; categories: number; mandatory: number; live: number; planned: number };
}
interface Delivery {
  id: string;
  eventKey: string;
  channel: Channel;
  status: 'delivered' | 'sent' | 'logged' | 'skipped' | 'failed';
  provider: string;
  at: string;
}
interface Deliveries {
  items: Delivery[];
  summary: { total: number; byChannel: Record<Channel, number>; byStatus: Record<Delivery['status'], number> };
}

const CHANNEL_NAME: Record<Channel, string> = { email: 'Email', inapp: 'In-app', sms: 'SMS', push: 'Push', whatsapp: 'WhatsApp' };
const SEVERITY_CHIP: Record<Note['severity'], string> = { info: 'plain', success: '', warning: 'gap', critical: 'bad' };
const STATUS_NAME: Record<Delivery['status'], string> = { delivered: 'Delivered (in-app)', sent: 'Sent by provider', logged: 'Recorded (sandbox)', skipped: 'Skipped (opted out)', failed: 'Failed' };

type Tab = 'inbox' | 'settings' | 'catalogue';

export default function NotificationsPage() {
  const { refreshWaiting } = useApp();
  const [tab, setTab] = useState<Tab>('inbox');
  const [inbox, setInbox] = useState<{ unread: number; items: Note[] }>();
  const [prefs, setPrefs] = useState<Prefs>();
  const [catalogue, setCatalogue] = useState<Catalogue>();
  const [deliveries, setDeliveries] = useState<Deliveries>();
  const [selected, setSelected] = useState('account.registered');
  const [preview, setPreview] = useState<{ subject: string; html: string }>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [i, p, c, d] = await Promise.all([api<{ unread: number; items: Note[] }>('/notifications'), api<Prefs>('/notifications/preferences'), api<Catalogue>('/notifications/catalogue'), api<Deliveries>('/notifications/deliveries')]);
      setInbox(i);
      setPrefs(p);
      setCatalogue(c);
      setDeliveries(d);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const byCategory = useMemo(() => (catalogue ? catalogue.categories.map((c) => ({ category: c, events: catalogue.events.filter((e) => e.category === c) })) : []), [catalogue]);

  async function markAll() {
    await api('/notifications/read', { method: 'POST', body: {} });
    await load();
    refreshWaiting();
  }
  async function markOne(id: string) {
    await api('/notifications/read', { method: 'POST', body: { ids: [id] } });
    await load();
    refreshWaiting();
  }
  async function savePrefs(next: Prefs) {
    setPrefs(next);
    setNotice('');
    try {
      await api('/notifications/preferences', { method: 'PUT', body: next });
      setNotice('Settings saved.');
    } catch (err) {
      setError(errorText(err));
    }
  }
  async function showPreview() {
    setError('');
    try {
      setPreview(await api<{ subject: string; html: string }>(`/notifications/preview?event=${encodeURIComponent(selected)}`));
    } catch (err) {
      setError(errorText(err));
    }
  }
  async function sendTest() {
    setError('');
    try {
      const r = await api<{ deliveries: Delivery[] }>('/notifications/test', { method: 'POST', body: { event: selected } });
      setNotice(`Test sent: ${r.deliveries.map((d) => `${CHANNEL_NAME[d.channel]} ${d.status}`).join(', ')}.`);
      await load();
      refreshWaiting();
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (error && !inbox) return <div className="note bad" role="alert">{error}</div>;
  if (!inbox || !prefs || !catalogue || !deliveries) return <p className="muted small">Loading notifications…</p>;

  const wired = catalogue.channels.filter((c) => c.wired).length;
  const reached = deliveries.summary.byStatus.delivered + deliveries.summary.byStatus.sent;
  const attempted = deliveries.summary.total - deliveries.summary.byStatus.skipped;

  return (
    <>
      <h2>Notifications</h2>
      <div className="seg" role="group" aria-label="Notification views">
        {(['inbox', 'settings', 'catalogue'] as Tab[]).map((t) => (
          <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t === 'inbox' ? `Inbox${inbox.unread ? ` (${inbox.unread})` : ''}` : t === 'settings' ? 'Settings' : 'Catalogue and delivery'}
          </button>
        ))}
      </div>
      {notice ? <div className="note ok" role="status">{notice}</div> : null}
      {error ? <div className="note bad" role="alert">{error}</div> : null}

      {tab === 'inbox' ? (
        <section className="stack" aria-label="Inbox">
          <div className="row">
            <p className="small muted grow">{inbox.items.length ? `${inbox.unread} unread of ${inbox.items.length}` : 'No notifications yet.'}</p>
            {inbox.unread ? (
              <button type="button" className="btn" onClick={markAll}>
                Mark all read
              </button>
            ) : null}
          </div>
          {inbox.items.map((n) => (
            <article key={n.id} className="card" data-testid="notification" style={n.readAt ? undefined : { borderColor: 'var(--accent)' }}>
              <div className="row">
                <span className={`chip ${SEVERITY_CHIP[n.severity]}`}>{n.severity}</span>
                <span className="small muted grow">
                  {n.category} · {new Date(n.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
                {n.readAt ? null : (
                  <button type="button" className="link" onClick={() => markOne(n.id)} aria-label={`Mark read: ${n.subject}`}>
                    Mark read
                  </button>
                )}
              </div>
              <h3>{n.subject}</h3>
              <p className="small">{n.body}</p>
            </article>
          ))}
        </section>
      ) : null}

      {tab === 'settings' ? (
        <section className="stack" aria-label="Notification settings">
          <div className="card">
            <span className="label">Channels</span>
            <p className="small muted">In-app notifications are always on. Service notices (marked below) are sent whatever you choose here.</p>
            {(['email', 'sms', 'push', 'whatsapp'] as const).map((c) => {
              const ch = catalogue.channels.find((x) => x.channel === c);
              // A channel with nothing behind it cannot be switched on; one already on can still be switched off.
              const cannot = c !== 'email' && !ch?.wired && !prefs[c];
              return (
                <label key={c} className={`confirm ${prefs[c] ? 'on' : ''}`}>
                  <input type="checkbox" disabled={cannot} checked={prefs[c]} onChange={(e) => savePrefs({ ...prefs, [c]: e.target.checked })} />
                  <span>
                    {CHANNEL_NAME[c]}
                    <br />
                    <span className="muted small">{ch?.wired ? `Connected (${ch.provider}).` : c === 'email' ? 'Sandbox: messages are recorded, not sent, until an e-mail provider is configured.' : 'Not connected yet: messages are recorded, not sent.'}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="card">
            <span className="label">Messages</span>
            <p className="small muted">Untick a message to keep it in-app only.</p>
            {byCategory.map(({ category, events }) => (
              <div key={category} className="stack" style={{ gap: 6 }}>
                <b className="small">{category}</b>
                {events
                  .filter((e) => e.live)
                  .map((e) => (
                    <label key={e.key} className="row small">
                      <input type="checkbox" disabled={e.mandatory} checked={e.mandatory || !prefs.muted.includes(e.key)} onChange={(ev) => savePrefs({ ...prefs, muted: ev.target.checked ? prefs.muted.filter((k) => k !== e.key) : [...prefs.muted, e.key] })} />
                      <span className="grow">{e.name}</span>
                      {e.mandatory ? <span className="chip plain">Service notice</span> : null}
                    </label>
                  ))}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {tab === 'catalogue' ? (
        <section className="stack" aria-label="Catalogue and delivery">
          <p className="small muted">One event engine: each event fans out to e-mail, in-app, SMS, push and WhatsApp according to the catalogue and your settings.</p>
          <StatTiles
            items={[
              { label: `Catalogue events in ${catalogue.stats.categories} categories`, value: catalogue.stats.events, testId: 'stat-events' },
              { label: `Live now · ${catalogue.stats.planned} planned`, value: catalogue.stats.live },
              { label: 'Service notices (ignore opt-outs)', value: catalogue.stats.mandatory },
              { label: `Reached you · of ${attempted} attempted`, value: reached },
              { label: 'Channels connected of 5', value: wired },
            ]}
          />
          <div className="card">
            <BarList title="Channel coverage: catalogue events per channel" rows={catalogue.channels.map((c) => ({ label: `${CHANNEL_NAME[c.channel]}${c.wired ? '' : ' (not connected)'}`, value: c.events, detail: `${CHANNEL_NAME[c.channel]}: ${c.events} events · ${deliveries.summary.byChannel[c.channel] ?? 0} deliveries to you` }))} max={catalogue.stats.events} valueHead="Events" />
          </div>
          <div className="card">
            <BarList title="Your deliveries by outcome" rows={(Object.keys(STATUS_NAME) as Delivery['status'][]).map((s) => ({ label: STATUS_NAME[s], value: deliveries.summary.byStatus[s] ?? 0 }))} valueHead="Deliveries" />
          </div>
          <div className="card">
            <span className="label">Template check</span>
            <p className="small muted">Preview the branded e-mail exactly as a recipient sees it, or fire the event to yourself on its channels. Without a provider key, e-mail is recorded in sandbox mode, so the flow can always be tested.</p>
            <select aria-label="Event to preview" value={selected} onChange={(e) => setSelected(e.target.value)}>
              {byCategory.map(({ category, events }) => (
                <optgroup key={category} label={category}>
                  {events.map((e) => (
                    <option key={e.key} value={e.key}>
                      {e.name} — {e.key}
                      {e.live ? '' : ' (planned)'}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div className="row">
              <button type="button" className="btn" onClick={showPreview}>
                Preview e-mail
              </button>
              <button type="button" className="btn primary" onClick={sendTest}>
                Send test to me
              </button>
            </div>
            {preview ? <iframe title={`E-mail preview: ${preview.subject}`} sandbox="" srcDoc={preview.html} style={{ width: '100%', height: 360, border: '1px solid var(--line)', borderRadius: 10, background: '#fff' }} /> : null}
          </div>
          <div className="card">
            <span className="label">Recent deliveries</span>
            {deliveries.items.length ? (
              <table className="small" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th align="left">Channel</th>
                    <th align="left">Event</th>
                    <th align="left">Outcome</th>
                    <th align="left">When</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.items.slice(0, 20).map((d) => (
                    <tr key={d.id} data-testid="delivery">
                      <td>{CHANNEL_NAME[d.channel]}</td>
                      <td className="num" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
                        {d.eventKey}
                      </td>
                      <td>
                        {d.status} · {d.provider}
                      </td>
                      <td>{new Date(d.at).toLocaleTimeString('en-GB')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="small muted">No deliveries yet.</p>
            )}
          </div>
          {byCategory.map(({ category, events }) => (
            <details key={category} className="card">
              <summary>
                <b>{category}</b> <span className="muted small">· {events.length} events</span>
              </summary>
              {events.map((e) => (
                <div key={e.key} className="crit">
                  <span className={`chip ${SEVERITY_CHIP[e.severity]}`}>{e.severity}</span>
                  <span>
                    <b>{e.name}</b> {e.mandatory ? <span className="chip plain">service notice</span> : null} {e.live ? null : <span className="chip plain">planned</span>}
                    <br />
                    <span className="num small muted">{e.key}</span>
                  </span>
                  <span className="ev">
                    “{e.subject}” · {e.channels.map((c) => CHANNEL_NAME[c]).join(', ')}
                  </span>
                </div>
              ))}
            </details>
          ))}
        </section>
      ) : null}
    </>
  );
}
