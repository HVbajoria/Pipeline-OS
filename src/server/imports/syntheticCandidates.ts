import type { CandidateRecord } from '../../shared/models';

/** Candidate records intentionally marked as fixture data, not sourced people. */
export interface SyntheticCandidateRecord extends CandidateRecord {
  readonly synthetic: true;
  readonly dataOrigin: 'synthetic';
}

const SYNTHETIC_CANDIDATES: readonly SyntheticCandidateRecord[] = [
  {
    id: 'synthetic-candidate-1',
    name: 'Synthetic Candidate Alpha',
    email: 'synthetic.alpha@candidate.example.test',
    resumeText:
      'Synthetic backend engineer with experience designing test services and reliable APIs.',
    skills: ['TypeScript', 'Node.js', 'Testing'],
    experienceYears: 6,
    resumeTextHistory: [],
    synthetic: true,
    dataOrigin: 'synthetic'
  },
  {
    id: 'synthetic-candidate-2',
    name: 'Synthetic Candidate Beta',
    email: 'synthetic.beta@candidate.example.test',
    resumeText:
      'Synthetic product engineer focused on accessible interfaces and iterative delivery.',
    skills: ['React', 'Accessibility', 'JavaScript'],
    experienceYears: 3,
    resumeTextHistory: [],
    synthetic: true,
    dataOrigin: 'synthetic'
  },
  {
    id: 'synthetic-candidate-3',
    name: 'Synthetic Candidate Gamma',
    email: 'synthetic.gamma@candidate.example.test',
    resumeText:
      'Synthetic data engineer working with analytics pipelines and reproducible experiments.',
    skills: ['Python', 'SQL', 'Data Engineering'],
    experienceYears: 8,
    resumeTextHistory: [],
    synthetic: true,
    dataOrigin: 'synthetic'
  }
];

function cloneSyntheticCandidate(
  candidate: SyntheticCandidateRecord
): SyntheticCandidateRecord {
  return {
    ...candidate,
    skills: [...candidate.skills],
    resumeTextHistory: [...candidate.resumeTextHistory]
  };
}

/**
 * Return a fresh deterministic fixture set. This is not used by createSeed;
 * callers must explicitly opt into it for demos or tests.
 */
export function createSyntheticCandidates(): SyntheticCandidateRecord[] {
  return SYNTHETIC_CANDIDATES.map(cloneSyntheticCandidate);
}

export const createSyntheticCandidateFixtures = createSyntheticCandidates;
export const getSyntheticCandidates = createSyntheticCandidates;

export function isSyntheticCandidate(
  candidate: CandidateRecord
): candidate is SyntheticCandidateRecord {
  return (
    (candidate as Partial<SyntheticCandidateRecord>).synthetic === true &&
    (candidate as Partial<SyntheticCandidateRecord>).dataOrigin === 'synthetic'
  );
}
