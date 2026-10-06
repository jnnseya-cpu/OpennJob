'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApp } from '../../components/AppShell';
import { api, errorText } from '../../lib/api';
import { STATUS_LABEL } from '../../lib/labels';
import type { Application } from '../../lib/types';

const ORDER: Record<Application['status'], number> = { draft: 0, confirmed: 1, submitted: 2 };
const MODE_NAME: Record<Application['mode'], string> = { review: 'review all', hybrid: 'hybrid', auto: 'auto' };

export default function TrackerPage() {
  const { agentMessage } = useApp();
  const [apps, setApps] = useState<Application[]>();
  const [error, setError] = useState('');

  useEffect(() => {
    api<Application[]>('/applications')
      .then((list) => setApps([...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.createdAt.localeCompare(a.createdAt))))
      .catch((err) => setError(errorText(err)));
  }, []);

  return (
    <>
      <h2>Tracker</h2>
      {agentMessage ? <div className="note ok" role="status">{agentMessage}</div> : null}
      {error ? <div className="note bad" role="alert">{error}</div> : null}
      {apps === undefined && !error ? <p className="muted small">Loading…</p> : null}
      {apps && !apps.length ? <div className="empty">No applications yet. Open a match, or tap Run agent on the Matches tab.</div> : null}
      <div className="stack">
        {apps?.map((a) => (
          <div key={a.id} className="card" data-testid="application">
            <div className="row">
              <div className="grow">
                <h3>{a.jobTitle}</h3>
                <p className="muted small">
                  {a.employer} · {a.score}% match · {MODE_NAME[a.mode]} mode · prepared {new Date(a.createdAt).toLocaleDateString('en-GB')}
                </p>
              </div>
              <span className={`chip ${a.status === 'draft' ? 'gap' : ''}`}>{STATUS_LABEL[a.status]}</span>
            </div>
            <div className="row">
              <Link className={`btn ${a.status === 'submitted' ? '' : 'primary'}`} href={`/review/?job=${encodeURIComponent(a.jobId)}`}>
                {a.status === 'draft' ? 'Review and approve' : a.status === 'confirmed' ? 'Next steps' : 'View'}
              </Link>
            </div>
          </div>
        ))}
      </div>
      <p className="small muted">Replies from employers are not tracked yet: OpennJob does not read your email.</p>
    </>
  );
}
