'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Small, dependency-free charts. Rules followed (see the dataviz guide): one colour per single
 * series, a threshold drawn as a rule with its own label, values in ink not series colour,
 * hover and keyboard tooltips, and every chart has a table view.
 */

interface Tip {
  x: number;
  y: number;
  text: string;
}

function useTip() {
  const [tip, setTip] = useState<Tip>();
  const show = (e: { currentTarget: Element }, text: string, host: HTMLElement | null) => {
    if (!host) return;
    const r = e.currentTarget.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    setTip({ x: r.left - h.left + r.width / 2, y: r.top - h.top - 4, text });
  };
  const node = tip ? (
    <div className="viz-tip" role="status" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>
  ) : null;
  return { show, hide: () => setTip(undefined), node };
}

function TableView({ caption, head, rows }: { caption: string; head: [string, string]; rows: [string, string | number][] }) {
  return (
    <details>
      <summary>Show as table</summary>
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{head[0]}</th>
            <th scope="col">{head[1]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="n">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function StatTiles({ items }: { items: { label: string; value: ReactNode; testId?: string }[] }) {
  return (
    <div className="stats">
      {items.map((s) => (
        <div key={s.label} className="stat" data-testid={s.testId}>
          <strong>{s.value}</strong>
          <span>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

export interface BarRow {
  label: string;
  value: number;
  /** Shown in the tooltip; defaults to the value. */
  detail?: string;
}

/** Horizontal bars, one series, one colour. Bars are focusable for keyboard tooltips. */
export function BarList({ title, rows, unit = '', max, valueHead = 'Value', empty = 'Nothing to show yet.' }: { title: string; rows: BarRow[]; unit?: string; max?: number; valueHead?: string; empty?: string }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const tip = useTip();
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure className="viz" ref={setHost} aria-label={title} style={{ margin: 0 }}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="small muted">{empty}</p>
      ) : (
        <div className="viz-rows">
          {rows.map((r) => {
            const text = r.detail ?? `${r.label}: ${r.value}${unit}`;
            return (
              <div
                key={r.label}
                className="viz-row"
                tabIndex={0}
                aria-label={text}
                onMouseEnter={(e) => tip.show(e, text, host)}
                onMouseLeave={tip.hide}
                onFocus={(e) => tip.show(e, text, host)}
                onBlur={tip.hide}
              >
                <span className="viz-label">{r.label}</span>
                <span className="viz-track">
                  <span style={{ width: `${Math.max(0, Math.min(100, (r.value / top) * 100))}%` }} />
                </span>
                <span className="viz-value">
                  {r.value}
                  {unit}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {tip.node}
      {rows.length ? <TableView caption={title} head={['Item', valueHead]} rows={rows.map((r) => [r.label, `${r.value}${unit}`])} /> : null}
    </figure>
  );
}

/** Columns for a distribution, with an optional threshold rule (e.g. the 80% apply line). HTML, so text stays at text size. */
export function Histogram({ title, bins, threshold, thresholdLabel }: { title: string; bins: { label: string; from: number; count: number }[]; threshold?: number; thresholdLabel?: string }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const tip = useTip();
  const top = Math.max(1, ...bins.map((b) => b.count));
  const total = bins.reduce((n, b) => n + b.count, 0);
  return (
    <figure className="viz" ref={setHost} aria-label={title} style={{ margin: 0 }}>
      <h3>{title}</h3>
      <div className="viz-hist" role="img" aria-label={`${title}: ${bins.map((b) => `${b.label} ${b.count}`).join(', ')}`}>
        <div className="viz-cols">
          {bins.map((b) => {
            const text = `${b.label}: ${b.count} job${b.count === 1 ? '' : 's'}`;
            return (
              <div key={b.label} className="viz-col" tabIndex={0} aria-label={text} onMouseEnter={(e) => tip.show(e, text, host)} onMouseLeave={tip.hide} onFocus={(e) => tip.show(e, text, host)} onBlur={tip.hide}>
                {b.count > 0 ? <span style={{ height: `${(b.count / top) * 100}%` }} /> : null}
              </div>
            );
          })}
          {threshold !== undefined ? (
            <div className="viz-rule" style={{ left: `${threshold}%` }} aria-hidden="true">
              <em>{thresholdLabel ?? `${threshold}%`}</em>
            </div>
          ) : null}
        </div>
        <div className="viz-axis">
          {bins.map((b) => (
            <span key={b.label}>{b.label}</span>
          ))}
        </div>
      </div>
      {tip.node}
      <p className="small muted">{total} job{total === 1 ? '' : 's'} in this view.</p>
      <TableView caption={title} head={['Score band', 'Jobs']} rows={bins.map((b) => [b.label, b.count])} />
    </figure>
  );
}

/** Ordered stages as one segmented bar (ordinal ramp), with a labelled legend so colour is never alone. */
export function StageBar({ title, stages }: { title: string; stages: { label: string; count: number }[] }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const tip = useTip();
  const total = stages.reduce((n, s) => n + s.count, 0);
  const colour = (i: number) => `var(--viz-stage-${Math.min(3, i + 1)})`;
  return (
    <figure className="viz" ref={setHost} aria-label={title} style={{ margin: 0 }}>
      <h3>{title}</h3>
      {total === 0 ? (
        <p className="small muted">No applications yet.</p>
      ) : (
        <div className="viz-stage" role="img" aria-label={stages.map((s) => `${s.label} ${s.count}`).join(', ')}>
          {stages.map((s, i) =>
            s.count > 0 ? (
              <span
                key={s.label}
                tabIndex={0}
                aria-label={`${s.label}: ${s.count}`}
                style={{ flex: s.count, background: colour(i) }}
                onMouseEnter={(e) => tip.show(e, `${s.label}: ${s.count} of ${total}`, host)}
                onMouseLeave={tip.hide}
                onFocus={(e) => tip.show(e, `${s.label}: ${s.count} of ${total}`, host)}
                onBlur={tip.hide}
              />
            ) : null,
          )}
        </div>
      )}
      <div className="viz-legend">
        {stages.map((s, i) => (
          <span key={s.label}>
            <i style={{ background: colour(i) }} />
            {s.label} · {s.count}
          </span>
        ))}
      </div>
      {tip.node}
      <TableView caption={title} head={['Stage', 'Applications']} rows={stages.map((s) => [s.label, s.count])} />
    </figure>
  );
}

/** Score bands used by every match histogram. */
export function scoreBins(scores: number[]) {
  const bands = [0, 20, 40, 60, 80];
  return bands.map((from, i) => ({
    label: i === bands.length - 1 ? '80–100' : `${from}–${from + 19}`,
    from,
    count: scores.filter((s) => s >= from && (i === bands.length - 1 ? s <= 100 : s < from + 20)).length,
  }));
}
