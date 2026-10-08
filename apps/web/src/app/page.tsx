'use client';

import Link from 'next/link';
import { ThemeToggle } from '../components/ThemeToggle';
import { useEffect, useRef } from 'react';
import './landing.css';

/** Public landing page. Signed-in visitors are sent to their dashboard by the shell. */

function useReveal() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const els = root.current?.querySelectorAll('.lp-reveal, .lp-stage') ?? [];
    if (!('IntersectionObserver' in window)) {
      els.forEach((e) => e.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), io.unobserve(e.target))),
      { threshold: 0.15 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  return root;
}

const PACKS = ['Construction and infrastructure', 'Data centres', 'Energy and grid', 'Rail and transport', 'Francophone Africa', 'Healthcare'];

export default function Landing() {
  const root = useReveal();
  return (
    <div className="lp" ref={root}>
      <div className="lp-grain" aria-hidden="true" />
      <div className="lp-wrap">
        <nav className="lp-nav" aria-label="Site">
          <Link href="/" className="mark" aria-label="OpennJob home">
            {/* eslint-disable-next-line @next/next/no-img-element -- static export: no image optimiser */}
            <img src="/brand/opennjob-logo-192.png" alt="OpennJob" width={84} height={84} />
          </Link>
          <span className="sp" />
          <a className="quiet hide-sm" href="#how">How it works</a>
          <a className="quiet hide-sm" href="#limits">What it will not do</a>
          <ThemeToggle className="lp-theme" />
          <Link className="quiet" href="/signin/">Sign in</Link>
        </nav>

        <header className="lp-hero">
          {/* eslint-disable-next-line @next/next/no-img-element -- static export: no image optimiser */}
          <img className="lp-logo-hero lp-reveal" src="/brand/opennjob-logo-512.png" alt="" width={260} height={260} />
          <p className="lp-eyebrow lp-reveal">Private pilot · by invitation</p>
          <h1 className="lp-reveal">
            The applications are drafted. <em>The signature is yours.</em>
          </h1>
          <p className="lp-lede lp-reveal">
            OpennJob reads the jobs, scores each one against what your CV can actually prove, and prepares the application for every role at
            or above your threshold. You check it and press submit, or let it submit on certified employer sites under your standing authorisation.
          </p>
          <div className="lp-cta lp-reveal">
            <Link className="lp-btn solid" href="/register/">
              Request access
            </Link>
            <a className="lp-btn" href="#how">
              See how it works
            </a>
          </div>
          <p className="lp-fine lp-reveal">Pilot accounts only. If you have an invitation, register with the address it was sent to.</p>
        </header>

        <figure className="lp-stage" aria-label="The review screen, with fictional data">
          <div className="lp-screen">
            <div className="lp-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="lp-ui">
              <div className="lp-card">
                <div className="lp-row">
                  <div className="g">
                    <h4>Senior Construction Manager · Hospital New Build</h4>
                    <p>Halden Build Group (example) · Birmingham</p>
                  </div>
                  <span className="lp-score">92%</span>
                </div>
                <div className="lp-bar">
                  <span style={{ ['--w' as string]: '92%' }} />
                </div>
                <div className="lp-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <span className="lp-chip ok">All essentials met</span>
                  <span className="lp-chip">Found on the employer’s careers page</span>
                  <span className="lp-chip ok">Draft ready</span>
                </div>
                <div>
                  <div className="lp-crit">
                    <span className="lp-chip ok">Met</span>
                    <span>Chartered status (MCIOB or MRICS)</span>
                    <q>Chartered Construction Manager, MCIOB.</q>
                  </div>
                  <div className="lp-crit">
                    <span className="lp-chip ok">Met</span>
                    <span>Multi-contractor site leadership</span>
                    <q>Led multi-contractor delivery across civil, MEP and HV packages.</q>
                  </div>
                  <div className="lp-crit">
                    <span className="lp-chip warn">Gap</span>
                    <span>NEC4 contract administration</span>
                  </div>
                </div>
              </div>
              <div className="lp-card">
                <h4>Only you confirm these</h4>
                <p>OpennJob answers a declaration only with the answer you saved yourself; anything else waits for you.</p>
                <div className="lp-box">
                  <b />
                  <span>Right to work for this country</span>
                </div>
                <div className="lp-box">
                  <b />
                  <span>Criminal convictions declaration</span>
                </div>
                <div className="lp-box">
                  <b />
                  <span>Conflict of interest declaration</span>
                </div>
                <div className="lp-box">
                  <b />
                  <span>Any “I confirm” statement on the form</span>
                </div>
                <span className="lp-chip" style={{ alignSelf: 'flex-start' }}>
                  Approve stays locked until each one is ticked
                </span>
              </div>
            </div>
          </div>
          <figcaption className="lp-caption">The review screen as it appears in the product. Employer and job are fictional.</figcaption>
        </figure>

        <section className="lp-section" id="how">
          <p className="lp-eyebrow lp-reveal">How it works</p>
          <h2 className="lp-reveal">Four steps, and the last one is always yours.</h2>
          <div className="lp-steps">
            <div className="lp-step lp-reveal">
              <div>
                <h3>It reads the jobs</h3>
                <p>From employers’ own careers pages and job boards. Employers do not need to sign up for anything.</p>
              </div>
            </div>
            <div className="lp-step lp-reveal">
              <div>
                <h3>It scores against evidence</h3>
                <p>Each requirement is matched to a sentence in your CV, and you see which sentence. A missing licence stays missing, whatever the score.</p>
              </div>
            </div>
            <div className="lp-step lp-reveal">
              <div>
                <h3>It prepares the application</h3>
                <p>For every eligible role at or above your threshold: a supporting statement built from your own words, your details, your documents.</p>
              </div>
            </div>
            <div className="lp-step lp-reveal">
              <div>
                <h3>You check it and you submit</h3>
                <p>You press submit on the employer’s form, or, under your standing authorisation, the extension submits on a certified site when every question is answered from your own records. OpennJob records the receipt and keeps the tracker.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-section" id="limits">
          <p className="lp-eyebrow lp-reveal">What it will not do</p>
          <h2 className="lp-reveal">The parts we decided to leave to you.</h2>
          <div className="lp-not lp-reveal">
            <div>
              <h3>Answer a declaration</h3>
              <p>Vetting, health, safeguarding and fitness to practise are answered by you, every time. Convictions, conflicts of interest and “I confirm” boxes are answered only from the answers you saved yourself.</p>
            </div>
            <div>
              <h3>Invent experience</h3>
              <p>Statements are built from what your CV says. A gap is shown to you as a gap, not written around.</p>
            </div>
            <div>
              <h3>Get past a CAPTCHA</h3>
              <p>When a site asks for a human, it stops and tells you. No workarounds, no disguised browsers.</p>
            </div>
            <div>
              <h3>Keep your data after you leave</h3>
              <p>Download everything it holds about you, or delete your account and all of it, from your account page.</p>
            </div>
          </div>
        </section>

        <section className="lp-section">
          <p className="lp-eyebrow lp-reveal">Where it works first</p>
          <div className="lp-packs lp-reveal">
            {PACKS.map((p) => (
              <span key={p}>{p}</span>
            ))}
          </div>
        </section>

        <section className="lp-pilot lp-reveal" aria-label="Pilot">
          <p className="lp-eyebrow">The pilot</p>
          <h2>Built with one applicant before it is offered to anyone else.</h2>
          <p>
            OpennJob is being proved with a single experienced construction and infrastructure professional. It opens to others once it has
            earned real interviews. Until then, accounts are by invitation.
          </p>
          <div className="lp-cta">
            <Link className="lp-btn solid" href="/register/">
              I have an invitation
            </Link>
            <Link className="lp-btn" href="/signin/">
              Sign in
            </Link>
          </div>
        </section>

        <footer className="lp-foot">
          <span>© {new Date().getFullYear()} OpennJob</span>
          <span>
            Contact: <a href="mailto:support@opennjob.com">support@opennjob.com</a>
          </span>
          <span>Pilot build. Terms and privacy notice in preparation.</span>
          <span>No job or interview is guaranteed.</span>
        </footer>
      </div>
    </div>
  );
}
