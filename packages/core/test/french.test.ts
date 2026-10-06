import { describe, expect, it } from 'vitest';
import {
  FRENCH_FALLBACK_OPENING,
  FakeLlm,
  PACK_QUESTION_BANK,
  PACKS,
  STAR_SYSTEM_PROMPT,
  STATEMENT_SYSTEM_PROMPT,
  STATEMENT_SYSTEM_PROMPT_FR,
  buildCriteriaPrompt,
  buildStarPrompt,
  buildStatementPrompt,
  draftStatement,
  draftStatementFallback,
  findPackQuestion,
  matchJob,
  questionsForPack,
  scoreAnswer,
  scoreStarHeuristic,
  splitSentences,
} from '../src';
import type { Criterion, JobLanguage } from '../src';

/** Entirely fictional person and employers. The CV is in English and says nothing about languages or the DRC. */
const CV = [
  'Mireille Kabongo-Example - Construction Manager',
  'Client-side construction manager with twelve years on major infrastructure programmes.',
  'Delivered a 400kV grid connection for Tees Grid Connections (example).',
  'Led HV commissioning for two substations with a multi-contractor workforce.',
  'Chaired weekly HSE reviews and closed 40 actions.',
].join('\n');

const criteria: Criterion[] = [
  { label: 'Major infrastructure programmes', essential: true, keywords: ['infrastructure'] },
  { label: 'Grid and HV systems', essential: true, keywords: ['grid', 'hv'] },
  { label: 'French, fluent', essential: true, keywords: ['french', 'français'] },
  { label: 'Mining sector projects', essential: true, keywords: ['mining', 'minier'] },
  { label: 'DRC experience', essential: false, keywords: ['drc', 'rdc', 'congo', 'kinshasa'] },
];
const jobIn = (language?: JobLanguage) => ({
  title: 'Directeur de projet - Infrastructure énergétique',
  employer: 'Compagnie Énergie du Fleuve (example)',
  criteria,
  requiresRegistration: false,
  ...(language ? { language } : {}),
});
const inputFor = (language?: JobLanguage, languages: string[] = []) => {
  const job = jobIn(language);
  return { job, cvText: CV, match: matchJob(job, CV, undefined, { languages }) };
};

describe('statement prompt: French applications', () => {
  it('asks for formal French when job.language is "fr"', () => {
    const { system, prompt } = buildStatementPrompt(inputFor('fr'));
    expect(system).toBe(STATEMENT_SYSTEM_PROMPT_FR);
    expect(system).toMatch(/formal French/);
    expect(system).toMatch(/vouvoiement/);
    expect(prompt).toMatch(/Write the statement in formal French \(vouvoiement\)/);
    expect(prompt).not.toMatch(/UK English/);
  });

  it('asks for UK English when the job is in English or has no stated language', () => {
    for (const language of ['en', undefined] as const) {
      const { system, prompt } = buildStatementPrompt(inputFor(language));
      expect(system).toBe(STATEMENT_SYSTEM_PROMPT);
      expect(prompt).toMatch(/UK English spelling/);
      expect(`${system}\n${prompt}`).not.toMatch(/French \(vouvoiement\)|formal French/);
    }
  });

  it('keeps the evidence rule in French: only the CV, no invention, gaps listed, and translation may add nothing', () => {
    const { system, prompt } = buildStatementPrompt(inputFor('fr'));
    expect(system).toMatch(/Use only evidence that is present in the CV/);
    expect(system).toMatch(/Never invent experience/);
    expect(system).toMatch(/translation must not add, strengthen or generalise any claim/);
    expect(system).toMatch(/Keep the marker "GAPS:"/);
    expect(prompt).toMatch(/using only evidence present in the CV below/);
    expect(prompt).toMatch(/Never invent experience/);
    expect(prompt).toContain(CV);
    // The two rules that do not depend on language are word for word the same in both system prompts.
    const shared = STATEMENT_SYSTEM_PROMPT.split('\n').slice(0, 4);
    expect(STATEMENT_SYSTEM_PROMPT_FR.split('\n').slice(0, 4)).toEqual(shared);
  });

  it('marks unevidenced criteria as not to be claimed, and quotes real CV sentences for the rest', () => {
    const { prompt } = buildStatementPrompt(inputFor('fr'));
    expect(prompt).toContain('2. Grid and HV systems - CV evidence: "Delivered a 400kV grid connection for Tees Grid Connections (example)."');
    expect(prompt).toContain('3. French, fluent - NO EVIDENCE IN CV (do not claim; list under GAPS)');
    expect(prompt).toContain('4. Mining sector projects - NO EVIDENCE IN CV (do not claim; list under GAPS)');
    for (const quoted of [...prompt.matchAll(/CV evidence: "([^"]+)"/g)].map((m) => m[1] as string)) expect(CV).toContain(quoted);
  });

  it('a language the candidate selected is passed on as their statement, never as CV evidence', () => {
    const { prompt } = buildStatementPrompt(inputFor('fr', ['French']));
    expect(prompt).toContain('3. French, fluent - NOT IN THE CV. The applicant states in their profile that they speak French.');
    expect(prompt).toMatch(/nothing more about it \(no level, no examples\)/);
    expect(prompt).not.toMatch(/French, fluent - CV evidence/);
  });
});

describe('fallback drafter: French applications', () => {
  it('opens in French when job.language is "fr"', () => {
    const draft = draftStatementFallback(inputFor('fr'));
    expect(draft.statement.startsWith('Madame, Monsieur,\n')).toBe(true);
    expect(draft.statement.startsWith(FRENCH_FALLBACK_OPENING)).toBe(true);
    expect(draft.source).toBe('fallback');
    expect(draft.warnings.join(' ')).toMatch(/only the opening is in French/);
  });

  it('does not open in French for an English job', () => {
    for (const language of ['en', undefined] as const) {
      const draft = draftStatementFallback(inputFor(language));
      expect(draft.statement).not.toContain('Madame');
      expect(draft.statement.split('\n')[0]).toBe('Client-side construction manager with twelve years on major infrastructure programmes.');
      expect(draft.warnings.join(' ')).not.toMatch(/French/);
    }
  });

  it('uses only evidence from the CV: after the fixed opening every line is a sentence copied from the CV', () => {
    const draft = draftStatementFallback(inputFor('fr', ['French']));
    const body = draft.statement.slice(FRENCH_FALLBACK_OPENING.length).split('\n').filter(Boolean);
    const cvSentences = splitSentences(CV);
    expect(body).toEqual([
      'Client-side construction manager with twelve years on major infrastructure programmes.',
      'Delivered a 400kV grid connection for Tees Grid Connections (example).',
    ]);
    for (const line of body) expect(cvSentences).toContain(line);
    // The fixed opening makes no claim about the applicant: no experience, employer, qualification or language.
    expect(FRENCH_FALLBACK_OPENING).toBe('Madame, Monsieur,\nVeuillez trouver ci-dessous les éléments de mon CV qui répondent aux critères du poste.');
  });

  it('never claims a criterion the CV does not evidence, in either language', () => {
    for (const language of ['fr', 'en'] as const) {
      const draft = draftStatementFallback(inputFor(language, ['French']));
      expect(draft.statement).not.toMatch(/mining|minier|congo|kinshasa|rdc/i);
      // The selected language counts for the score, but the no-LLM draft copies CV sentences only, so it does not mention it.
      expect(draft.statement).not.toMatch(/french|français|francophone/i);
      expect(draft.gaps).toEqual(['Mining sector projects']);
    }
    expect(draftStatementFallback(inputFor('fr')).gaps).toEqual(['French, fluent', 'Mining sector projects']);
  });

  it('adds no French opening to an empty draft', () => {
    const job = { ...jobIn('fr'), criteria: [{ label: 'Mining sector projects', essential: true, keywords: ['mining'] }] };
    const draft = draftStatementFallback({ job, cvText: CV, match: matchJob(job, CV, undefined) });
    expect(draft.statement).toBe('');
    expect(draft.warnings.join(' ')).toMatch(/draft is empty/);
  });
});

describe('draftStatement with an LLM: French applications', () => {
  it('sends the French system prompt, takes gaps from the match, and flags a claim the CV does not support', async () => {
    const llm = new FakeLlm(() => "Madame, Monsieur,\nJ'ai dirigé des programmes d'infrastructure et je possède une solide expérience du secteur minier.\n\nGAPS:\n- aucune");
    const input = inputFor('fr');
    const draft = await draftStatement(input, llm);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.system).toBe(STATEMENT_SYSTEM_PROMPT_FR);
    expect(draft.source).toBe('llm');
    expect(draft.statement).not.toMatch(/GAPS/);
    // The LLM said "none"; the gaps still come from the match.
    expect(draft.gaps).toEqual(['French, fluent', 'Mining sector projects']);
    expect(draft.warnings.join(' ')).toMatch(/mentions criteria your CV does not evidence: Mining sector projects/);
  });

  it('falls back to the French-opening draft when the LLM call fails', async () => {
    const draft = await draftStatement(inputFor('fr'), new FakeLlm(() => { throw new Error('boom'); }));
    expect(draft.source).toBe('fallback');
    expect(draft.statement.startsWith('Madame, Monsieur,')).toBe(true);
  });

  it('asks the criteria extractor for French labels and bilingual keywords on a French advert', () => {
    expect(buildCriteriaPrompt('Nous recrutons un directeur de projet.', 'Directeur de projet')).toMatch(/For an advert written in French, write the labels in French and give keywords in both French and English/);
  });
});

describe('interview question bank per pack', () => {
  it('has the three demo questions for each of the six packs, with stable ids', () => {
    expect(PACK_QUESTION_BANK).toHaveLength(18);
    expect(new Set(PACK_QUESTION_BANK.map((q) => q.id)).size).toBe(18);
    for (const pack of PACKS) {
      const questions = questionsForPack(pack.id);
      expect(questions.map((q) => q.text)).toEqual(pack.questions);
      expect(questions.map((q) => q.id)).toEqual([`${pack.id}-1`, `${pack.id}-2`, `${pack.id}-3`]);
      expect(questions.every((q) => q.pack === pack.id)).toBe(true);
    }
    expect(findPackQuestion('rail-2')?.text).toBe('Tell me about introducing BIM to a team that resisted it.');
    expect(findPackQuestion('hc-1')?.text).toBe('Tell me about a time you recognised that a patient was deteriorating. What did you do?');
    expect(findPackQuestion('rail-9')).toBeUndefined();
  });

  it('asks French questions in the francophone pack, and English questions everywhere else', () => {
    expect(questionsForPack('fr').map((q) => [q.id, q.language])).toEqual([['fr-1', 'fr'], ['fr-2', 'en'], ['fr-3', 'fr']]);
    expect(findPackQuestion('fr-1')?.text).toBe("Parlez-nous d'un programme d'infrastructure que vous avez redressé.");
    expect(findPackQuestion('fr-3')?.text).toBe('Comment gérez-vous plusieurs sous-traitants sur un chantier éloigné ?');
    expect(PACK_QUESTION_BANK.filter((q) => q.pack !== 'fr').every((q) => q.language === 'en')).toBe(true);
  });
});

/** Fictional answers. */
const FRENCH_ANSWER =
  "Lorsque j'ai repris le chantier de la sous-station, le programme accusait douze semaines de retard et trois sous-traitants ne se parlaient plus. " +
  "Mon rôle était de rétablir le planning sans compromettre la sécurité. J'ai d'abord réuni les trois chefs de chantier, puis j'ai établi un planning commun " +
  "et j'ai suivi les jalons chaque matin. J'ai aussi présenté au client un rapport hebdomadaire. " +
  "Au final nous avons rattrapé 9 semaines et la mise sous tension a été livrée à la date prévue. J'ai appris à traiter les interfaces dès le premier jour.";
const ENGLISH_ANSWER =
  'When I took over the substation site the programme was twelve weeks late and three subcontractors had stopped talking to each other. ' +
  'My role was to recover the schedule without compromising safety. I first called the three site leads together, then I made one shared plan and I checked the milestones every morning. ' +
  'As a result we recovered 9 weeks and energisation was achieved on the planned date. I learned to deal with interfaces from the first day.';

describe('interview feedback answers in the language of the answer', () => {
  it('the LLM prompt says so, whatever language the question was asked in', () => {
    expect(STAR_SYSTEM_PROMPT).toMatch(/Write your feedback in the language the candidate answered in/);
    const prompt = buildStarPrompt("Parlez-nous d'un programme d'infrastructure que vous avez redressé.", ENGLISH_ANSWER);
    expect(prompt).toMatch(/in the same language as the candidate's answer: French if the answer is in French, UK English if it is in English, whatever language the question was asked in/);
    expect(prompt).toMatch(/Keep the JSON keys in English/);
    expect(prompt).toContain(ENGLISH_ANSWER);
    // The same instruction is there for an English question with a French answer.
    expect(buildStarPrompt('Tell me about a programme you recovered.', FRENCH_ANSWER)).toMatch(/French if the answer is in French/);
  });

  it('the no-LLM scorer gives French advice for a French answer and English advice for an English one', () => {
    const fr = scoreStarHeuristic("J'ai géré le chantier avec mon équipe pour le client.");
    expect(fr.improvements[0]).toBe("La réponse est très courte. Visez 150 à 250 mots environ (deux minutes à l'oral).");
    expect(fr.improvements.join(' ')).not.toMatch(/The answer is|Aim for/);
    const en = scoreStarHeuristic('I managed the site with my team for the client.');
    expect(en.improvements[0]).toBe('The answer is very short. Aim for around 150 to 250 words (about two minutes spoken).');
    expect(en.improvements.join(' ')).not.toMatch(/réponse|Visez/);
  });

  it('finds every STAR part in a full French answer, as it does in the English one', () => {
    const fr = scoreStarHeuristic(FRENCH_ANSWER);
    const en = scoreStarHeuristic(ENGLISH_ANSWER);
    for (const feedback of [fr, en]) {
      expect(feedback.source).toBe('heuristic');
      for (const part of ['situation', 'task', 'action', 'result'] as const) expect(feedback.scores[part], part).toBeGreaterThanOrEqual(2); // 2 = one cue found, 0 = part missing
      expect(feedback.total).toBe(feedback.scores.situation + feedback.scores.task + feedback.scores.action + feedback.scores.result);
    }
    expect(fr.strengths.every((s) => /bien traitée/.test(s))).toBe(true);
    expect(fr.strengths.length).toBeGreaterThan(0);
    expect(en.strengths.every((s) => /clearly covered/.test(s))).toBe(true);
  });

  it('follows the answer, not the question: an English answer to a French question gets English feedback', async () => {
    const feedback = await scoreAnswer({ question: 'Comment gérez-vous plusieurs sous-traitants sur un chantier éloigné ?', answer: 'I managed the site.' });
    expect(feedback.improvements[0]).toMatch(/^The answer is very short/);
    const other = await scoreAnswer({ question: 'How do you plan work around possessions and a live railway?', answer: "J'ai géré le chantier pour le client." });
    expect(other.improvements[0]).toMatch(/^La réponse est très courte/);
  });
});
