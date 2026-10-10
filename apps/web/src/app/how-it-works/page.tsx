import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'How it works · OpennJob' };

export default function HowItWorksPage() {
  return (
    <article className="prose">
      <h2>How OpennJob works</h2>
      <p>Five steps, the same on a laptop or a phone. You decide how much OpennJob does on its own.</p>

      <h3>1. Set up your profile once</h3>
      <p>
        Upload or paste your CV, set your preferences (sectors, locations, salary floor, permanent or contract), and fill the one-time
        answers you are happy for OpennJob to reuse — including your right-to-work record for a country and the plain declarations you
        choose to answer yourself in advance.
      </p>

      <h3>2. OpennJob finds and scores jobs</h3>
      <p>
        It searches job boards’ official sources and employer career sites, and scores each role against your CV. Every requirement is
        matched to a sentence in your CV, so you can see <i>why</i> a job scored what it did. A missing licence stays missing, whatever the score.
      </p>

      <h3>3. It prepares each application</h3>
      <p>
        For roles above your threshold, OpennJob writes a tailored CV and a supporting statement from your own words, and shows an
        <b> ATS-readiness</b> check so you know how well it would pass an employer’s applicant-tracking system. Every line is checked
        against your CV; unsupported claims are removed, never invented.
      </p>

      <h3>4. You apply — automatically where it can, with your pack everywhere else</h3>
      <ul>
        <li><b>By e-mail (automatic):</b> when an advert names a recruiter’s e-mail address, and you have switched on automatic sending, OpennJob e-mails your CV and statement there in your name, within your daily limit.</li>
        <li><b>On an employer’s form (you submit):</b> OpennJob gives you a ready-to-submit pack — your details and statement with one-tap copy, your CV and cover letter as PDFs, and the declarations flagged as yours to answer. You press submit.</li>
      </ul>
      <p className="small muted">
        OpennJob never answers a declaration for you, and in automatic mode it never submits a form that asks one. This is why it is
        “review-light”, not “hands-off everywhere”.
      </p>

      <h3>5. Track everything</h3>
      <p>
        Your tracker shows what was prepared, sent and submitted, with the site’s own confirmation recorded as the receipt, plus your
        interview rate and interview practice drawn from what you actually sent.
      </p>

      <h3>The three modes</h3>
      <ul>
        <li><b>Review:</b> you see and confirm every field before anything is filled.</li>
        <li><b>Hybrid:</b> OpennJob prepares everything; you confirm and submit.</li>
        <li><b>Auto:</b> OpennJob sends by e-mail where it can; employer forms still come to you as a pack.</li>
      </ul>

      <h3>On your phone</h3>
      <p>
        Everything above works in your phone’s browser — there is <b>no app to install</b> (you can “Add to Home Screen” for an icon if you like).
      </p>
      <ul>
        <li><b>Set up and find jobs:</b> upload or paste your CV, set preferences, then <i>Look for jobs</i> and <i>Run agent</i>. The finding, scoring and writing all happen on our servers, so your phone just waits a moment.</li>
        <li><b>Automatic by e-mail:</b> where an advert names a recruiter’s address and you’ve turned on Auto, OpennJob sends for you — nothing to tap.</li>
        <li><b>Employer forms — the pack:</b> on the Review screen, tap <i>Copy</i> for your details and your statement, download the CV and cover letter PDFs, open the employer’s form, paste them in, answer the declarations yourself, and press submit. About a minute.</li>
        <li><b>Track:</b> your tracker shows what was sent and your interview rate; submitted jobs drop out of your matches.</li>
      </ul>
      <p className="small muted">
        Honest summary: on a phone it is <b>review-light, not zero-touch</b> — automatic where it is safe (e-mail), a quick copy-and-paste pack for employer forms. There is no browser extension on mobile, so forms are always the manual pack.
      </p>

      <p className="small muted">
        OpennJob does not guarantee a job or an interview. Ready to try the free check? <Link href="/score/">Check your CV against a job</Link>, or <Link href="/register/">create an account</Link>.
      </p>
    </article>
  );
}
