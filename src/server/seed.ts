/**
 * Deterministic PipelineOS seed data and read-only catalogs.
 *
 * The factories in this module always allocate fresh maps and object graphs.
 * They intentionally do not use the wall clock or a random identifier source;
 * operation-created records get their timestamps and IDs from the repository's
 * injected Clock and IdGenerator instead.
 */

import type {
  AvailabilityCalendar,
  CandidateRecord,
  CompetencyGroup,
  InterviewPanel,
  JobRequisition,
  OnboardingTaskTemplate,
  PlanCatalog,
  RoleTemplate,
  SharedCatalogs,
  SharedState,
  SharedStateWithCatalogs,
  StartDate,
  Timestamp
} from '../shared/models';

/** Stable timestamp used for seed records. */
export const SEED_TIMESTAMP: Timestamp = '2026-08-15T09:00:00Z';

/** Fixed demo start date used by onboarding due-date calculations. */
export const START_DATE: StartDate = '2026-09-07T09:00:00Z';
export const DEMO_START_DATE = START_DATE;

/** Stable seed job used by the end-to-end demo flow. */
export const SEED_JOB_ID = 'job-1';
export const SEED_PANEL_ID = 'panel-1';

const commonInterviewSlots: Timestamp[] = [
  '2026-09-01T10:00:00Z',
  '2026-09-01T14:00:00Z',
  '2026-09-02T11:00:00Z',
  '2026-09-02T15:00:00Z',
  '2026-09-03T09:00:00Z'
];

const additionalInterviewSlot = '2026-09-04T13:00:00Z';

function createSeedJobs(): Map<string, JobRequisition> {
  return new Map([
    [
      SEED_JOB_ID,
      {
        id: SEED_JOB_ID,
        title: 'Senior Backend Engineer',
        department: 'Engineering',
        requirements: ['Node.js', 'Express', 'PostgreSQL', 'AWS'],
        compBand: { min: 1800000, max: 2600000, currency: 'INR' },
        status: 'open',
        createdBy: 'priya-recruiter',
        createdAt: SEED_TIMESTAMP
      }
    ]
  ]);
}

function createSeedCandidates(): Map<string, CandidateRecord> {
  return new Map([
    [
      'cand-1',
      {
        id: 'cand-1',
        name: 'Ananya Sharma',
        email: 'ananya.sharma@example.com',
        resumeText:
          'Experienced backend engineer with 8 years building scalable APIs.',
        skills: ['Node.js', 'TypeScript', 'AWS', 'Go'],
        experienceYears: 8,
        resumeTextHistory: []
      }
    ],
    [
      'cand-2',
      {
        id: 'cand-2',
        name: 'Rohan Mehta',
        email: 'rohan.mehta@example.com',
        resumeText:
          'Frontend developer specializing in React and CSS animations.',
        skills: ['React', 'CSS', 'JavaScript'],
        experienceYears: 3,
        resumeTextHistory: []
      }
    ],
    [
      'cand-3',
      {
        id: 'cand-3',
        name: 'Kavya Iyer',
        email: 'kavya.iyer@example.com',
        resumeText: 'Backend engineer focused on data engineering.',
        skills: ['Python', 'Django', 'SQL'],
        experienceYears: 5,
        resumeTextHistory: []
      }
    ]
  ]);
}

function createSeedPanels(): Map<string, InterviewPanel> {
  return new Map([
    [
      SEED_PANEL_ID,
      {
        id: SEED_PANEL_ID,
        jobId: SEED_JOB_ID,
        interviewers: [
          {
            id: 'interviewer-1',
            name: 'Arjun Nair',
            role: 'Engineering Manager'
          },
          {
            id: 'interviewer-2',
            name: 'Divya Krishnan',
            role: 'Senior Backend Engineer'
          },
          {
            id: 'interviewer-3',
            name: 'Vikram Reddy',
            role: 'Platform Architect'
          }
        ]
      }
    ]
  ]);
}

/**
 * Every seeded interviewer shares the five common slots. The extra slot is
 * intentionally available to only two interviewers, making the intersection
 * behavior observable while keeping the first three proposal slots stable.
 */
function createAvailabilityCalendar(): AvailabilityCalendar {
  return new Map([
    ['interviewer-1', [...commonInterviewSlots, additionalInterviewSlot]],
    ['interviewer-2', [...commonInterviewSlots, additionalInterviewSlot]],
    ['interviewer-3', [...commonInterviewSlots]]
  ]);
}

function competencyGroups(
  groups: Array<[name: string, questions: string[]]>
): CompetencyGroup[] {
  return groups.map(([name, questions]) => ({
    name,
    questions: [...questions]
  }));
}

function onboardingTasks(
  tasks: Array<[taskName: string, offsetDays: number]>
): OnboardingTaskTemplate[] {
  return tasks.map(([taskName, offsetDays]) => ({ taskName, offsetDays }));
}

function createRoleTemplates(): RoleTemplate[] {
  return [
    {
      id: 'template-engineering',
      roleMatcher: 'engineering',
      competencies: competencyGroups([
        [
          'System Design',
          [
            'How would you scale a service that handles rapidly growing traffic?',
            'Describe a tradeoff you made in a distributed system.'
          ]
        ],
        [
          'Backend Coding',
          [
            'How do you keep an API reliable as its data model evolves?',
            'Explain the time and space complexity of a recent implementation.'
          ]
        ],
        [
          'Reliability',
          [
            'How would you diagnose a production latency regression?',
            'What signals would you use to define service health?'
          ]
        ],
        [
          'Collaboration',
          [
            'Tell me about a technical disagreement and how you resolved it.',
            'How do you communicate risk to non-engineering partners?'
          ]
        ]
      ]),
      onboardingTasks: onboardingTasks([
        ['Provision engineering accounts', 0],
        ['Review security and deployment policies', 3],
        ['Join the platform onboarding session', 7]
      ])
    },
    {
      id: 'template-generic',
      roleMatcher: 'generic',
      competencies: competencyGroups([
        [
          'Role Expertise',
          [
            'What accomplishment best demonstrates the skills needed for this role?',
            'How do you keep your professional knowledge current?'
          ]
        ],
        [
          'Problem Solving',
          [
            'Walk through a difficult problem and the steps you took to solve it.'
          ]
        ],
        [
          'Collaboration',
          [
            'How do you build alignment when teammates have different priorities?',
            'What does effective feedback look like to you?'
          ]
        ]
      ]),
      onboardingTasks: onboardingTasks([
        ['Complete new-hire paperwork', 0],
        ['Review company policies', 3]
      ])
    },
    {
      id: 'template-product',
      roleMatcher: 'product',
      competencies: competencyGroups([
        [
          'Product Strategy',
          [
            'How would you decide which customer problem to solve next?',
            'Describe how you measure whether a product change worked.'
          ]
        ],
        [
          'Execution',
          [
            'How do you turn an ambiguous goal into an executable plan?'
          ]
        ],
        [
          'Customer Empathy',
          [
            'Tell me about a time customer research changed your direction.'
          ]
        ]
      ]),
      onboardingTasks: onboardingTasks([
        ['Meet the product team', 0],
        ['Review the product roadmap', 5],
        ['Complete customer context training', 10]
      ])
    }
  ];
}

function createPlanCatalog(): PlanCatalog {
  return {
    medical: ['medical-basic', 'medical-plus', 'medical-premium'],
    dental: ['dental-basic', 'dental-plus'],
    vision: ['vision-basic', 'vision-plus']
  };
}

/** Create a fresh copy of the immutable catalogs. */
export function createSeedCatalogs(): SharedCatalogs {
  return {
    availabilityCalendar: createAvailabilityCalendar(),
    roleTemplates: createRoleTemplates(),
    planCatalog: createPlanCatalog(),
    startDate: START_DATE
  };
}

/** Create the empty mutable collections and deterministic seed records. */
export function createSeedState(): SharedState {
  return {
    revision: 0,
    jobs: createSeedJobs(),
    candidates: createSeedCandidates(),
    applications: new Map(),
    panels: createSeedPanels(),
    interviews: new Map(),
    scorecards: new Map(),
    offers: new Map(),
    onboardingTasks: new Map(),
    backgroundChecks: new Map(),
    benefitsEnrollments: new Map(),
    approvalCards: new Map(),
    sourcedProspects: new Map(),
    activityLog: []
  };
}

/** A repository-ready seed with state and read-only catalogs together. */
export function createSeed(): SharedStateWithCatalogs {
  return {
    ...createSeedState(),
    catalogs: createSeedCatalogs()
  };
}

/** Explicit bundle shape for callers that keep state and catalogs separate. */
export interface SeedData {
  state: SharedState;
  catalogs: SharedCatalogs;
}

export function createSeedData(): SeedData {
  return {
    state: createSeedState(),
    catalogs: createSeedCatalogs()
  };
}

// Descriptive aliases make the deterministic factory convenient for tests and
// for the server composition root without exporting mutable singleton state.
export const createInitialState = createSeedState;
export const createInitialCatalogs = createSeedCatalogs;
export const createInitialSeed = createSeed;
export const getSeedState = createSeedState;
export const getSeedCatalogs = createSeedCatalogs;

/** The catalog keys are intentionally exposed for validation/UI documentation. */
export const PLAN_CATALOG: PlanCatalog = createPlanCatalog();

/**
 * A stable, read-only view of the common seed slots. Consumers should prefer
 * repository catalogs; this export is useful for deterministic fixtures.
 */
export const SEED_INTERVIEW_SLOTS: readonly Timestamp[] = Object.freeze([
  ...commonInterviewSlots
]);
