import { create } from 'zustand';
import type {
  ActivityLogEntry,
  ApplicationRecord,
  BackgroundCheckRecord,
  BenefitsEnrollmentRecord,
  CandidateRecord,
  InterviewPanel,
  InterviewRecord,
  JobRequisition,
  OfferRecord,
  OnboardingTaskRecord,
  ScorecardRecord,
  SharedCatalogProjection,
  SharedStateProjectionWithCatalogs
} from '../shared/models';
import {
  actorContextForRole,
  ROLE_ACTOR_IDS,
  type AppRole,
  type HumanRole
} from '../client/actorContext';
import { PipelineError, type PipelineErrorPayload } from '../shared/errors';

export interface AppState {
  revision: number;
  jobs: JobRequisition[];
  candidates: CandidateRecord[];
  applications: ApplicationRecord[];
  panels: InterviewPanel[];
  interviews: InterviewRecord[];
  scorecards: ScorecardRecord[];
  offers: OfferRecord[];
  onboardingTasks: OnboardingTaskRecord[];
  backgroundChecks: BackgroundCheckRecord[];
  benefitsEnrollments: BenefitsEnrollmentRecord[];
  activityLog: ActivityLogEntry[];
  catalogs: SharedCatalogProjection;
}

export interface StoreState extends AppState {
  currentRole: AppRole;
  roleActors: Readonly<Record<HumanRole, string>>;
  setRole: (role: AppRole) => void;
  hydrate: (snapshot: SharedStateProjectionWithCatalogs) => void;
  fetchState: () => Promise<void>;
  resetState: () => Promise<void>;
  snapshot: () => SharedStateProjectionWithCatalogs;
}

const EMPTY_CATALOGS: SharedCatalogProjection = {
  availabilityCalendar: [],
  roleTemplates: [],
  planCatalog: { medical: [], dental: [], vision: [] },
  startDate: ''
};

const INITIAL_STATE: AppState = {
  revision: 0,
  jobs: [],
  candidates: [],
  applications: [],
  panels: [],
  interviews: [],
  scorecards: [],
  offers: [],
  onboardingTasks: [],
  backgroundChecks: [],
  benefitsEnrollments: [],
  activityLog: [],
  catalogs: EMPTY_CATALOGS
};

async function bodyFor(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function assertResponse(response: Response): Promise<unknown> {
  const body = await bodyFor(response);
  if (!response.ok) throw PipelineError.from(body as PipelineErrorPayload);
  return body;
}

/**
 * Keep the client projection isolated from response objects and callers of
 * `snapshot()`. The server projection is JSON-safe, so structuredClone is the
 * preferred path with a JSON fallback for older browser/test runtimes.
 */
function cloneProjection(
  snapshot: SharedStateProjectionWithCatalogs
): SharedStateProjectionWithCatalogs {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(snapshot);
  }
  return JSON.parse(JSON.stringify(snapshot)) as SharedStateProjectionWithCatalogs;
}

export const useStore = create<StoreState>((set, get) => ({
  ...INITIAL_STATE,
  roleActors: ROLE_ACTOR_IDS,
  currentRole: 'recruiter',
  setRole: (role) => set({ currentRole: role }),
  hydrate: (snapshot) => {
    const next = cloneProjection(snapshot);
    set({
      revision: next.revision,
      jobs: next.jobs,
      candidates: next.candidates,
      applications: next.applications,
      panels: next.panels,
      interviews: next.interviews,
      scorecards: next.scorecards,
      offers: next.offers,
      onboardingTasks: next.onboardingTasks,
      backgroundChecks: next.backgroundChecks,
      benefitsEnrollments: next.benefitsEnrollments,
      activityLog: next.activityLog,
      catalogs: next.catalogs
    });
  },
  fetchState: async () => {
    const response = await fetch('/api/state', {
      method: 'GET',
      headers: { accept: 'application/json' }
    });
    const body = await assertResponse(response);
    if (!body || typeof body !== 'object') {
      throw new Error('State endpoint returned an invalid projection');
    }
    get().hydrate(body as SharedStateProjectionWithCatalogs);
  },
  resetState: async () => {
    const resetResponse = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    await assertResponse(resetResponse);
    await get().fetchState();
  },
  snapshot: () => {
    const state = get();
    return cloneProjection({
      revision: state.revision,
      jobs: state.jobs,
      candidates: state.candidates,
      applications: state.applications,
      panels: state.panels,
      interviews: state.interviews,
      scorecards: state.scorecards,
      offers: state.offers,
      onboardingTasks: state.onboardingTasks,
      backgroundChecks: state.backgroundChecks,
      benefitsEnrollments: state.benefitsEnrollments,
      activityLog: state.activityLog,
      catalogs: state.catalogs
    });
  }
}));

export function currentHumanActor(role: AppRole = useStore.getState().currentRole) {
  return actorContextForRole(role);
}

export { EMPTY_CATALOGS };
