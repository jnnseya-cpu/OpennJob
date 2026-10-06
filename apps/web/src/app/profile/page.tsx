'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useApp } from '../../components/AppShell';
import { BarList } from '../../components/Charts';
import { ScreeningForm } from '../../components/ScreeningForm';
import { ApiError, api, errorText, upload } from '../../lib/api';
import { COUNTRIES, KNOWN_CITIES, LANGUAGES, PACKS, WORK_RIGHTS_BASES, cityCountry, countryName, getPack } from '../../lib/core';
import type { PackCredentialField } from '../../lib/core';
import type { CvExtraction, Passport, PassportView, Profile, PublicUser } from '../../lib/types';

type Details = Omit<Profile, 'preferences' | 'addressLine2'> & { addressLine2: string };
const EMPTY_DETAILS: Details = { firstName: '', lastName: '', email: '', phone: '', addressLine1: '', addressLine2: '', city: '', postcode: '', cvText: '' };

interface Prefs {
  languages: string[];
  countries: string[];
  cities: string[];
  searchTypes?: string[];
  minScore?: number | undefined;
}

interface TrainingRow {
  name: string;
  completedOn: string;
  expiresOn: string;
}
interface RefereeRow {
  name: string;
  relationship: string;
  organisation: string;
  email: string;
  phone: string;
}
const EMPTY_REFEREE: RefereeRow = { name: '', relationship: '', organisation: '', email: '', phone: '' };

/** OD-5: one country's right to work and sponsorship, resting on a document the person holds. */
interface WorkRightsRow {
  country: string;
  rightToWork: '' | 'yes' | 'no';
  requiresSponsorship: '' | 'yes' | 'no';
  basis: string;
  documentExpires: string;
  /** Never pre-ticked: the person confirms the answers are true and they hold the document. */
  confirmed: boolean;
  /** When the person last confirmed this record (from the API). */
  confirmedAt?: string;
}
const EMPTY_WORK_RIGHTS: WorkRightsRow = { country: 'GB', rightToWork: '', requiresSponsorship: '', basis: '', documentExpires: '', confirmed: false };

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** The credential lines to show: the chosen pack's, or every pack's (each once) for "All industry packs". */
function credentialFields(pack: string): PackCredentialField[] {
  const own = getPack(pack);
  if (own) return own.credentialFields;
  const seen = new Map<string, PackCredentialField>();
  for (const p of PACKS) for (const f of p.credentialFields) if (!seen.has(f.id)) seen.set(f.id, f);
  return [...seen.values()];
}

const STATUS_TEXT: Record<string, string> = { valid: 'In date', expiring: 'Expires soon', expired: 'Expired', 'no-expiry': 'No expiry', 'invalid-date': 'Check the date' };

export default function ProfilePage() {
  const { pack } = useApp();
  const [loaded, setLoaded] = useState(false);
  const [details, setDetails] = useState<Details>(EMPTY_DETAILS);
  const [prefs, setPrefs] = useState<Prefs>({ languages: [], countries: [], cities: [] });
  const [cityInput, setCityInput] = useState('');
  const [cityError, setCityError] = useState('');
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string }>();
  const [savingProfile, setSavingProfile] = useState(false);
  const [cv, setCv] = useState<CvExtraction>();
  const [cvError, setCvError] = useState('');
  const [reading, setReading] = useState(false);

  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [dbs, setDbs] = useState({ certificateNumber: '', issueDate: '', onUpdateService: false });
  // Never pre-ticked. It is the person's own statement; OpennJob does not verify it.
  const [rightToWork, setRightToWork] = useState(false);
  const [training, setTraining] = useState<TrainingRow[]>([]);
  const [trainingStatus, setTrainingStatus] = useState<PassportView['training']>([]);
  const [referees, setReferees] = useState<RefereeRow[]>([]);
  const [workRights, setWorkRights] = useState<WorkRightsRow[]>([]);
  const [passportMsg, setPassportMsg] = useState<{ ok: boolean; text: string }>();
  const [savingPassport, setSavingPassport] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const profile = await api<Profile>('/profile').catch((err) => {
          if (err instanceof ApiError && err.status === 404) return undefined;
          throw err;
        });
        const view = await api<PassportView>('/passport').catch((err) => {
          if (err instanceof ApiError && err.status === 404) return undefined;
          throw err;
        });
        if (!live) return;
        if (profile) {
          const { preferences, addressLine2, ...rest } = profile;
          setDetails({ ...rest, addressLine2: addressLine2 ?? '' });
          setPrefs({
            languages: preferences?.languages ?? [],
            countries: preferences?.countries ?? [],
            cities: preferences?.cities ?? [],
            ...(preferences?.searchTypes?.length ? { searchTypes: preferences.searchTypes } : {}),
            ...(typeof preferences?.minScore === 'number' ? { minScore: preferences.minScore } : {}),
          });
        } else {
          const me = await api<PublicUser>('/account');
          if (live) setDetails((d) => ({ ...d, email: me.email }));
        }
        if (view) applyPassport(view);
        if (live) setLoaded(true);
      } catch (err) {
        if (live) setLoadError(errorText(err));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  function applyPassport(view: PassportView) {
    const p = view.passport;
    const creds = { ...(p.credentials ?? {}) };
    if (p.nmcPin && !creds.pin) creds.pin = p.nmcPin;
    setCredentials(creds);
    setDbs({ certificateNumber: p.dbs?.certificateNumber ?? '', issueDate: p.dbs?.issueDate ?? '', onUpdateService: p.dbs?.onUpdateService ?? false });
    setRightToWork(p.rightToWorkConfirmed);
    setTraining(p.training.map((t) => ({ name: t.name, completedOn: t.completedOn ?? '', expiresOn: t.expiresOn ?? '' })));
    setReferees(p.referees.map((r) => ({ ...r })));
    setWorkRights(
      (p.workRights ?? []).map((r) => ({
        country: r.country,
        rightToWork: r.rightToWork ? 'yes' : 'no',
        requiresSponsorship: r.requiresSponsorship ? 'yes' : 'no',
        basis: r.basis,
        documentExpires: r.documentExpires ?? '',
        confirmed: true,
        confirmedAt: r.confirmedAt,
      })),
    );
    setTrainingStatus(view.training);
  }

  const knownCities = useMemo(
    () =>
      Object.entries(KNOWN_CITIES)
        .filter(([, code]) => prefs.countries.includes(code))
        .map(([city]) => city)
        .sort(),
    [prefs.countries],
  );
  const countryOptions = useMemo(() => [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name)), []);

  const set = (key: keyof Details) => (e: { target: { value: string } }) => setDetails((d) => ({ ...d, [key]: e.target.value }));

  function removeCountry(code: string) {
    setPrefs((p) => {
      const countries = p.countries.filter((c) => c !== code);
      return { ...p, countries, cities: countries.length ? p.cities.filter((c) => countries.includes(cityCountry(c) ?? '')) : [] };
    });
  }

  function addCity() {
    const value = cityInput.trim();
    if (!value) return;
    const code = cityCountry(value);
    if (!code) {
      setCityError('Write the city with its country code, for example "Lille, FR".');
      return;
    }
    if (!prefs.countries.includes(code)) {
      setCityError(`Add ${countryName(code) ?? code} to your countries first.`);
      return;
    }
    setCityError('');
    setCityInput('');
    setPrefs((p) => (p.cities.includes(value) ? p : { ...p, cities: [...p.cities, value] }));
  }

  async function readCv(file: File | undefined) {
    setCvError('');
    setCv(undefined);
    if (!file) return;
    const type = /\.pdf$/i.test(file.name) ? 'application/pdf' : /\.docx$/i.test(file.name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : '';
    if (!type) {
      setCvError('Choose a PDF or a Word (.docx) file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setCvError('The file is larger than 5 MB.');
      return;
    }
    setReading(true);
    try {
      setCv(await upload<CvExtraction>('/profile/cv', file, type));
    } catch (err) {
      setCvError(errorText(err));
    } finally {
      setReading(false);
    }
  }

  function applyCv() {
    if (!cv) return;
    const s = cv.suggestions;
    setDetails((d) => ({
      ...d,
      cvText: cv.text,
      firstName: d.firstName || s.firstName || '',
      lastName: d.lastName || s.lastName || '',
      email: d.email || s.email || '',
      phone: d.phone || s.phone || '',
      postcode: d.postcode || s.postcode || '',
      city: d.city || s.city || '',
    }));
    setCv(undefined);
    setProfileMsg({ ok: true, text: 'The CV text is in the box below. Check every line, then save your profile.' });
  }

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    setProfileMsg(undefined);
    try {
      const { addressLine2, ...rest } = details;
      await api('/profile', { method: 'PUT', body: { ...rest, ...(addressLine2.trim() ? { addressLine2 } : {}), preferences: { languages: prefs.languages, countries: prefs.countries, cities: prefs.cities, ...(prefs.searchTypes?.length ? { searchTypes: prefs.searchTypes } : {}), ...(prefs.minScore ? { minScore: prefs.minScore } : {}) } } });
      setProfileMsg({ ok: true, text: 'Profile saved. Your matches use it from now on.' });
    } catch (err) {
      setProfileMsg({ ok: false, text: errorText(err) });
    } finally {
      setSavingProfile(false);
    }
  }

  async function savePassport(e: FormEvent) {
    e.preventDefault();
    setSavingPassport(true);
    setPassportMsg(undefined);
    const creds = Object.fromEntries(Object.entries(credentials).filter(([, v]) => v.trim() !== ''));
    const dbsBody = {
      ...(dbs.certificateNumber.trim() ? { certificateNumber: dbs.certificateNumber.trim() } : {}),
      ...(dbs.issueDate ? { issueDate: dbs.issueDate } : {}),
      ...(dbs.onUpdateService ? { onUpdateService: true } : {}),
    };
    const rows = workRights.filter((r) => r.rightToWork || r.requiresSponsorship || r.basis || r.documentExpires);
    const incomplete = rows.find((r) => !r.rightToWork || !r.requiresSponsorship || !r.basis || !r.confirmed);
    if (incomplete) {
      setSavingPassport(false);
      setPassportMsg({ ok: false, text: `Right to work for ${countryName(incomplete.country) ?? incomplete.country}: answer both questions, choose the document you hold, and tick to confirm. Or remove that country.` });
      return;
    }
    const body: Omit<Passport, 'workRights'> & { workRights?: { country: string; rightToWork: boolean; requiresSponsorship: boolean; basis: string; documentExpires?: string; confirmed: true }[] } = {
      rightToWorkConfirmed: rightToWork,
      ...(rows.length
        ? {
            workRights: rows.map((r) => ({
              country: r.country,
              rightToWork: r.rightToWork === 'yes',
              requiresSponsorship: r.requiresSponsorship === 'yes',
              basis: r.basis,
              ...(r.documentExpires ? { documentExpires: r.documentExpires } : {}),
              confirmed: true as const,
            })),
          }
        : {}),
      ...(Object.keys(creds).length ? { credentials: creds } : {}),
      ...(Object.keys(dbsBody).length ? { dbs: dbsBody } : {}),
      training: training
        .filter((t) => t.name.trim())
        .map((t) => ({ name: t.name, ...(t.completedOn ? { completedOn: t.completedOn } : {}), ...(t.expiresOn ? { expiresOn: t.expiresOn } : {}) })),
      referees: referees.filter((r) => Object.values(r).some((v) => v.trim() !== '')),
    };
    try {
      const view = await api<PassportView>('/passport', { method: 'PUT', body });
      applyPassport(view);
      setPassportMsg({ ok: true, text: 'Credential passport saved.' });
    } catch (err) {
      setPassportMsg({ ok: false, text: errorText(err) });
    } finally {
      setSavingPassport(false);
    }
  }

  if (loadError) return <div className="note bad" role="alert">{loadError}</div>;
  if (!loaded) return <p className="muted small">Loading your profile…</p>;

  const fields = credentialFields(pack);
  const packName = getPack(pack)?.name;

  return (
    <>
      <h2>Profile</h2>
      <div className="cols">
        <form className="stack" onSubmit={saveProfile} aria-label="Profile">
          <section className="card">
            <span className="label">Your details</span>
            <div className="grid2">
              <label className="field"><span>First name</span><input type="text" autoComplete="given-name" value={details.firstName} onChange={set('firstName')} /></label>
              <label className="field"><span>Last name</span><input type="text" autoComplete="family-name" value={details.lastName} onChange={set('lastName')} /></label>
              <label className="field"><span>Email for applications</span><input type="email" autoComplete="email" value={details.email} onChange={set('email')} /></label>
              <label className="field"><span>Phone</span><input type="tel" autoComplete="tel" value={details.phone} onChange={set('phone')} /></label>
              <label className="field"><span>Address line 1</span><input type="text" autoComplete="address-line1" value={details.addressLine1} onChange={set('addressLine1')} /></label>
              <label className="field"><span>Address line 2 (optional)</span><input type="text" autoComplete="address-line2" value={details.addressLine2} onChange={set('addressLine2')} /></label>
              <label className="field"><span>Town or city</span><input type="text" autoComplete="address-level2" value={details.city} onChange={set('city')} /></label>
              <label className="field"><span>Postcode</span><input type="text" autoComplete="postal-code" value={details.postcode} onChange={set('postcode')} /></label>
            </div>
          </section>

          <section className="card">
            <label className="label" htmlFor="cv">CV</label>
            <textarea id="cv" style={{ minHeight: 260 }} value={details.cvText} onChange={set('cvText')} placeholder="Paste your CV as plain text. One achievement per line works best." />
            <div className="row">
              <label className="btn" htmlFor="cv-file">
                {reading ? 'Reading…' : 'Upload PDF or Word'}
              </label>
              <input id="cv-file" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} onChange={(e) => void readCv(e.target.files?.[0])} />
              <p className="small muted grow" id="upload-note">
                PDF or Word (.docx), up to 5 MB. The file is read and not kept. Match scores and drafts are built from the text in this box.
              </p>
            </div>
            {cvError ? <div className="note bad" role="alert">{cvError}</div> : null}
            {cv ? (
              <div className="stack" data-testid="cv-preview">
                <span className="label">Text read from your {cv.format === 'pdf' ? `PDF${cv.pages ? ` (${cv.pages} page${cv.pages === 1 ? '' : 's'})` : ''}` : 'Word file'}</span>
                {cv.warnings.map((w) => (
                  <div key={w} className="note">{w}</div>
                ))}
                <pre className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', background: 'var(--bg)', padding: 8, borderRadius: 8 }}>{cv.text}</pre>
                {Object.values(cv.suggestions).some(Boolean) ? (
                  <p className="small">
                    Found, for empty details only: {Object.entries(cv.suggestions).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' · ')}
                  </p>
                ) : null}
                <div className="row">
                  <button type="button" className="btn primary" onClick={applyCv}>
                    Use this text
                  </button>
                  <button type="button" className="link" onClick={() => setCv(undefined)}>
                    Discard
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="card">
            <span className="label">Where and how you can work</span>
            <p className="small muted">Select nothing and everything is open to you. Each selection narrows what the agent finds and prepares.</p>
            <span className="small">
              <b>Languages you speak</b> · {prefs.languages.length ? prefs.languages.join(', ') : 'any'}
            </span>
            <div className="row" role="group" aria-label="Languages you speak">
              {LANGUAGES.map((l) => (
                <button key={l} type="button" className={`chip ${prefs.languages.includes(l) ? '' : 'plain'}`} aria-pressed={prefs.languages.includes(l)} onClick={() => setPrefs((p) => ({ ...p, languages: toggle(p.languages, l) }))}>
                  {l}
                </button>
              ))}
            </div>
            <span className="small">
              <b>Countries</b> · {prefs.countries.length ? `${prefs.countries.length} selected` : 'anywhere'}
            </span>
            <select
              aria-label="Add a country"
              value=""
              onChange={(e) => {
                const code = e.target.value;
                if (code) setPrefs((p) => (p.countries.includes(code) ? p : { ...p, countries: [...p.countries, code] }));
              }}
            >
              <option value="">Add a country…</option>
              {countryOptions.map((c) => (
                <option key={c.code} value={c.code} disabled={prefs.countries.includes(c.code)}>
                  {c.name}
                </option>
              ))}
            </select>
            {prefs.countries.length ? (
              <div className="row" role="group" aria-label="Selected countries">
                {prefs.countries.map((code) => (
                  <button key={code} type="button" className="chip" aria-label={`Remove ${countryName(code) ?? code}`} onClick={() => removeCountry(code)}>
                    {countryName(code) ?? code} ×
                  </button>
                ))}
              </div>
            ) : null}
            <span className="small">
              <b>Cities</b> · {prefs.cities.length ? prefs.cities.join(', ') : 'anywhere in your countries'}
            </span>
            {prefs.countries.length ? (
              <>
                <div className="row" role="group" aria-label="Cities">
                  {[...new Set([...knownCities, ...prefs.cities])].map((c) => (
                    <button key={c} type="button" className={`chip ${prefs.cities.includes(c) ? '' : 'plain'}`} aria-pressed={prefs.cities.includes(c)} onClick={() => setPrefs((p) => ({ ...p, cities: toggle(p.cities, c) }))}>
                      {c}
                    </button>
                  ))}
                </div>
                <div className="row">
                  <input type="text" className="grow" aria-label="Another city" placeholder="Another city, for example Lille, FR" value={cityInput} onChange={(e) => setCityInput(e.target.value)} style={{ flex: 1 }} />
                  <button type="button" className="btn" onClick={addCity}>
                    Add city
                  </button>
                </div>
                {cityError ? <p className="small note">{cityError}</p> : null}
              </>
            ) : (
              <p className="small muted">Pick a country first to narrow by city.</p>
            )}
            <p className="small muted">A language you select counts as evidence for jobs that ask for it.</p>
            <label className="field">
              <span>
                <b>Prepare applications only at or above</b>
              </span>
              <select aria-label="Minimum match score" value={prefs.minScore ?? ''} onChange={(e) => setPrefs((p) => ({ ...p, minScore: e.target.value ? Number(e.target.value) : undefined }))}>
                <option value="">The platform’s threshold (80%)</option>
                {[85, 90, 95, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}%
                  </option>
                ))}
              </select>
            </label>
            <p className="small muted">Fewer, better-matched applications get more replies than many weak ones. The agent never goes below the platform’s threshold.</p>
          </section>

          {profileMsg ? <div className={`note ${profileMsg.ok ? 'ok' : 'bad'}`} role={profileMsg.ok ? 'status' : 'alert'}>{profileMsg.text}</div> : null}
          <button className="btn primary" type="submit" disabled={savingProfile}>
            {savingProfile ? 'Saving…' : 'Save profile'}
          </button>
        </form>

        <form className="card" onSubmit={savePassport} aria-label="Credential passport">
          <span className="label">Credential passport{packName ? ` · ${packName}` : ''}</span>
          <p className="small muted">
            Stored once, reused on every form. Everything here is treated as sensitive: the extension never fills any of it until you confirm
            it on the form. OpennJob does not verify what you enter.
          </p>
          {fields.map((f) => (
            <label key={f.id} className="field">
              <span>{f.label}</span>
              <input type="text" value={credentials[f.id] ?? ''} placeholder="Not added" onChange={(e) => setCredentials((c) => ({ ...c, [f.id]: e.target.value }))} />
            </label>
          ))}
          {pack !== 'all' ? <p className="small muted">Lines for other industry packs are kept as they are. Choose “All industry packs” at the top to see every line.</p> : null}

          <span className="label">DBS</span>
          <div className="grid2">
            <label className="field"><span>Certificate number (12 digits)</span><input type="text" inputMode="numeric" value={dbs.certificateNumber} onChange={(e) => setDbs((d) => ({ ...d, certificateNumber: e.target.value }))} /></label>
            <label className="field"><span>Issue date</span><input type="date" value={dbs.issueDate} onChange={(e) => setDbs((d) => ({ ...d, issueDate: e.target.value }))} /></label>
          </div>
          <label className={`confirm ${dbs.onUpdateService ? 'on' : ''}`}>
            <input type="checkbox" checked={dbs.onUpdateService} onChange={(e) => setDbs((d) => ({ ...d, onUpdateService: e.target.checked }))} />
            <span>On the DBS Update Service</span>
          </label>

          <span className="label">Right to work</span>
          <label className={`confirm ${rightToWork ? 'on' : ''}`}>
            <input type="checkbox" checked={rightToWork} onChange={(e) => setRightToWork(e.target.checked)} />
            <span>
              I have the right to work in the UK.
              <br />
              <span className="muted small">Your own statement; not checked by OpennJob. On its own, the extension asks you to confirm it on each form.</span>
            </span>
          </label>

          <section className="stack" aria-label="Right to work by country" data-testid="work-rights">
            <span className="label">Right to work and sponsorship, answered for you</span>
            <p className="small muted">
              For each country, answer once and name the document you hold. OpennJob then answers “Do you have the right to work in …?” and “Will you need
              visa sponsorship?” on forms for jobs in that country, without asking each time, until the document’s expiry date. OpennJob does not see or
              check the document. Every other declaration (convictions, “I confirm”, equality questions) is still yours on each form.
            </p>
            {workRights.map((r, i) => {
              const set = (patch: Partial<WorkRightsRow>) => setWorkRights((rows) => rows.map((x, j) => (j === i ? { ...x, ...patch, confirmed: 'confirmed' in patch ? Boolean(patch.confirmed) : false } : x)));
              return (
                <div key={i} className="card" data-testid="work-rights-row">
                  <div className="grid2">
                    <label className="field">
                      <span>Country</span>
                      <select value={r.country} onChange={(e) => set({ country: e.target.value })}>
                        {COUNTRIES.map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>The document you hold</span>
                      <select value={r.basis} onChange={(e) => set({ basis: e.target.value })}>
                        <option value="">Choose…</option>
                        {WORK_RIGHTS_BASES.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Do you have the right to work there?</span>
                      <select value={r.rightToWork} onChange={(e) => set({ rightToWork: e.target.value as WorkRightsRow['rightToWork'] })}>
                        <option value="">Choose…</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Will you need visa sponsorship there?</span>
                      <select value={r.requiresSponsorship} onChange={(e) => set({ requiresSponsorship: e.target.value as WorkRightsRow['requiresSponsorship'] })}>
                        <option value="">Choose…</option>
                        <option value="no">No</option>
                        <option value="yes">Yes</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Document expiry date (leave empty if none)</span>
                      <input type="date" value={r.documentExpires} onChange={(e) => set({ documentExpires: e.target.value })} />
                    </label>
                  </div>
                  <label className={`confirm ${r.confirmed ? 'on' : ''}`}>
                    <input type="checkbox" checked={r.confirmed} onChange={(e) => set({ confirmed: e.target.checked })} />
                    <span>
                      These answers are true and I hold this document. OpennJob may give them on application forms for jobs in {countryName(r.country) ?? r.country}.
                      {r.confirmedAt && r.confirmed ? <span className="muted small"> Confirmed {new Date(r.confirmedAt).toLocaleDateString('en-GB')}.</span> : null}
                    </span>
                  </label>
                  <button type="button" className="link" onClick={() => setWorkRights((rows) => rows.filter((_, j) => j !== i))}>
                    Remove this country
                  </button>
                </div>
              );
            })}
            {workRights.length < 10 ? (
              <button type="button" className="btn" onClick={() => setWorkRights((rows) => [...rows, { ...EMPTY_WORK_RIGHTS, country: rows.some((x) => x.country === 'GB') ? 'IE' : 'GB' }])}>
                Add a country
              </button>
            ) : null}
          </section>

          <span className="label">Mandatory training</span>
          {training.map((t, i) => {
            const status = trainingStatus.find((s) => s.name === t.name);
            return (
              <div key={i} className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                <div className="grid2">
                  <label className="field"><span>Training</span><input type="text" value={t.name} onChange={(e) => setTraining((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} /></label>
                  <label className="field"><span>Expires on</span><input type="date" value={t.expiresOn} onChange={(e) => setTraining((rows) => rows.map((r, j) => (j === i ? { ...r, expiresOn: e.target.value } : r)))} /></label>
                </div>
                <div className="row">
                  {status ? <span className={`chip ${status.status === 'expired' ? 'bad' : status.status === 'expiring' ? 'gap' : ''}`}>{STATUS_TEXT[status.status]}{status.status === 'expiring' && status.daysRemaining !== undefined ? `, ${status.daysRemaining} days left` : ''}</span> : null}
                  <button type="button" className="link" onClick={() => setTraining((rows) => rows.filter((_, j) => j !== i))}>Remove</button>
                </div>
              </div>
            );
          })}
          {trainingStatus.some((t) => t.daysRemaining !== undefined) ? (
            <BarList
              title="Days until each training expires"
              rows={trainingStatus.filter((t) => t.daysRemaining !== undefined).map((t) => ({ label: t.name, value: Math.max(0, t.daysRemaining ?? 0), detail: (t.daysRemaining ?? 0) < 0 ? `${t.name}: expired` : `${t.name}: ${t.daysRemaining} days left` }))}
              unit=" d"
              valueHead="Days left"
            />
          ) : null}
          <button type="button" className="btn" onClick={() => setTraining((rows) => [...rows, { name: '', completedOn: '', expiresOn: '' }])}>
            Add training
          </button>

          <span className="label">Referees (up to 3)</span>
          <p className="small muted">These are other people’s details. Tell them before you add them.</p>
          {referees.map((r, i) => (
            <div key={i} className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <div className="grid2">
                {(['name', 'relationship', 'organisation', 'email', 'phone'] as (keyof RefereeRow)[]).map((k) => (
                  <label key={k} className="field">
                    <span>Referee {i + 1}: {k}</span>
                    <input type={k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text'} value={r[k]} onChange={(e) => setReferees((rows) => rows.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} />
                  </label>
                ))}
              </div>
              <button type="button" className="link" onClick={() => setReferees((rows) => rows.filter((_, j) => j !== i))}>Remove referee</button>
            </div>
          ))}
          {referees.length < 3 ? (
            <button type="button" className="btn" onClick={() => setReferees((rows) => [...rows, { ...EMPTY_REFEREE }])}>
              Add referee
            </button>
          ) : null}

          {passportMsg ? <div className={`note ${passportMsg.ok ? 'ok' : 'bad'}`} role={passportMsg.ok ? 'status' : 'alert'}>{passportMsg.text}</div> : null}
          <button className="btn primary" type="submit" disabled={savingPassport}>
            {savingPassport ? 'Saving…' : 'Save passport'}
          </button>
        </form>
      </div>

      <ScreeningForm />
    </>
  );
}
