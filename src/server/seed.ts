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
  ApplicationRecord,
  BackgroundCheckRecord,
  BenefitsEnrollmentRecord,
  CandidateRecord,
  CompetencyGroup,
  InterviewPanel,
  InterviewRecord,
  JobRequisition,
  OfferRecord,
  OnboardingTaskRecord,
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

/** A repository-ready seed with read-only catalogs and no workflow records. */
export function createSeed(): SharedStateWithCatalogs {
  return {
    ...createSeedState(),
    catalogs: createSeedCatalogs()
  };
}

/**
 * Create the populated Indian-context dataset used by the hosted/demo app.
 *
 * This intentionally remains separate from createSeed(): tests and canonical
 * workflow examples rely on createSeed() starting with empty applications and
 * post-application collections. Every record is synthetic and deterministic,
 * so Reset Demo can restore the same Kanban story without an external service.
 */
export function createDemoSeed(): SharedStateWithCatalogs {
  const seed = createSeed();
  const createdAt = SEED_TIMESTAMP;

  const additionalCandidates: CandidateRecord[] = [
    {
      id: 'cand-4',
      name: 'Aarav Singh',
      email: 'aarav.singh@example.com',
      resumeText: 'Backend engineer with seven years building payment and ledger services for Indian fintech products.',
      skills: ['Node.js', 'TypeScript', 'PostgreSQL', 'AWS'],
      experienceYears: 7,
      resumeTextHistory: []
    },
    {
      id: 'cand-5',
      name: 'Meera Nair',
      email: 'meera.nair@example.com',
      resumeText: 'Platform engineer with nine years of experience running reliable cloud infrastructure and APIs.',
      skills: ['Node.js', 'AWS', 'Kubernetes', 'PostgreSQL'],
      experienceYears: 9,
      resumeTextHistory: []
    },
    {
      id: 'cand-6',
      name: 'Aditya Rao',
      email: 'aditya.rao@example.com',
      resumeText: 'Senior software engineer focused on distributed systems, developer tooling, and production reliability.',
      skills: ['Go', 'Node.js', 'AWS', 'PostgreSQL'],
      experienceYears: 10,
      resumeTextHistory: []
    },
    {
      id: 'cand-7',
      name: 'Ishita Verma',
      email: 'ishita.verma@example.com',
      resumeText: 'Full-stack engineer with five years delivering customer-facing web products and internal platforms.',
      skills: ['React', 'TypeScript', 'Node.js'],
      experienceYears: 5,
      resumeTextHistory: []
    },
    {
      id: 'cand-8',
      name: 'Nikhil Joshi',
      email: 'nikhil.joshi@example.com',
      resumeText: 'Backend engineer with four years building APIs and data pipelines for growing SaaS teams.',
      skills: ['Node.js', 'Python', 'SQL'],
      experienceYears: 4,
      resumeTextHistory: []
    }
  ];
  for (const candidate of additionalCandidates) {
    seed.candidates.set(candidate.id, candidate);
  }

  const application = (
    id: string,
    candidateId: string,
    status: ApplicationRecord['status'],
    screeningScore: number | null = null,
    screeningRationale: string | null = null
  ): ApplicationRecord => ({
    id,
    candidateId,
    jobId: SEED_JOB_ID,
    status,
    screeningScore,
    screeningRationale,
    notes: [],
    createdAt
  });

  seed.applications = new Map([
    ['demo-app-applied-1', application('demo-app-applied-1', 'cand-1', 'applied')],
    [
      'demo-app-screened',
      application(
        'demo-app-screened',
        'cand-2',
        'screened',
        35,
        'Matched 2 of 4 requirements (50%); candidate has 3 years of experience.'
      )
    ],
    ['demo-app-interviewing', application('demo-app-interviewing', 'cand-3', 'interviewing', 65, 'Matched 3 of 4 requirements (75%); candidate has 5 years of experience.')],
    ['demo-app-offer-sent', application('demo-app-offer-sent', 'cand-4', 'offer_sent', 90, 'Matched 4 of 4 requirements (100%); candidate has 7 years of experience.')],
    ['demo-app-offer-accepted', application('demo-app-offer-accepted', 'cand-5', 'offer_accepted', 95, 'Matched 4 of 4 requirements (100%); candidate has 9 years of experience.')],
    ['demo-app-onboarding', application('demo-app-onboarding', 'cand-6', 'onboarding', 95, 'Matched 4 of 4 requirements (100%); candidate has 10 years of experience.')],
    ['demo-app-rejected', application('demo-app-rejected', 'cand-7', 'rejected', 25, 'Matched 1 of 4 requirements (25%); candidate has 5 years of experience.')],
    ['demo-app-applied-2', application('demo-app-applied-2', 'cand-8', 'applied')]
  ]);

  const interview: InterviewRecord = {
    id: 'demo-interview-3',
    applicationId: 'demo-app-interviewing',
    panelId: SEED_PANEL_ID,
    slot: commonInterviewSlots[2]!,
    status: 'booked'
  };
  seed.interviews = new Map([[interview.id, interview]]);

  const sentOffer: OfferRecord = {
    id: 'demo-offer-sent',
    applicationId: 'demo-app-offer-sent',
    compAmount: 2300000,
    currency: 'INR',
    status: 'sent',
    counterAmount: null,
    sentAt: '2026-08-22T10:00:00Z',
    respondedAt: null
  };
  const acceptedOffer: OfferRecord = {
    id: 'demo-offer-accepted',
    applicationId: 'demo-app-offer-accepted',
    compAmount: 2400000,
    currency: 'INR',
    status: 'accepted',
    counterAmount: null,
    sentAt: '2026-08-21T10:00:00Z',
    respondedAt: '2026-08-24T10:00:00Z'
  };
  const onboardingOffer: OfferRecord = {
    id: 'demo-offer-onboarding',
    applicationId: 'demo-app-onboarding',
    compAmount: 2500000,
    currency: 'INR',
    status: 'accepted',
    counterAmount: null,
    sentAt: '2026-08-20T10:00:00Z',
    respondedAt: '2026-08-23T10:00:00Z'
  };
  seed.offers = new Map([
    [sentOffer.id, sentOffer],
    [acceptedOffer.id, acceptedOffer],
    [onboardingOffer.id, onboardingOffer]
  ]);

  seed.backgroundChecks = new Map<string, BackgroundCheckRecord>([
    [
      'demo-background-accepted',
      {
        id: 'demo-background-accepted',
        offerId: acceptedOffer.id,
        status: 'clear',
        initiatedAt: '2026-08-25T10:00:00Z',
        completedAt: '2026-08-25T10:00:00Z'
      }
    ],
    [
      'demo-background-onboarding',
      {
        id: 'demo-background-onboarding',
        offerId: onboardingOffer.id,
        status: 'clear',
        initiatedAt: '2026-08-24T10:00:00Z',
        completedAt: '2026-08-24T10:00:00Z'
      }
    ]
  ]);

  seed.benefitsEnrollments = new Map<string, BenefitsEnrollmentRecord>([
    [
      'demo-benefits-accepted',
      {
        id: 'demo-benefits-accepted',
        offerId: acceptedOffer.id,
        planSelections: {
          medical: 'medical-plus',
          dental: 'dental-plus',
          vision: 'vision-plus'
        },
        enrolledAt: '2026-08-26T10:00:00Z'
      }
    ],
    [
      'demo-benefits-onboarding',
      {
        id: 'demo-benefits-onboarding',
        offerId: onboardingOffer.id,
        planSelections: {
          medical: 'medical-basic',
          dental: 'dental-basic',
          vision: 'vision-basic'
        },
        enrolledAt: '2026-08-25T10:00:00Z'
      }
    ]
  ]);

  seed.onboardingTasks = new Map<string, OnboardingTaskRecord>([
    [
      'demo-task-onboarding-1',
      {
        id: 'demo-task-onboarding-1',
        offerId: onboardingOffer.id,
        taskName: 'Provision engineering accounts',
        status: 'complete',
        dueDate: '2026-09-07T09:00:00Z'
      }
    ],
    [
      'demo-task-onboarding-2',
      {
        id: 'demo-task-onboarding-2',
        offerId: onboardingOffer.id,
        taskName: 'Review security and deployment policies',
        status: 'in_progress',
        dueDate: '2026-09-10T09:00:00Z'
      }
    ],
    [
      'demo-task-onboarding-3',
      {
        id: 'demo-task-onboarding-3',
        offerId: onboardingOffer.id,
        taskName: 'Join the platform onboarding session',
        status: 'pending',
        dueDate: '2026-09-14T09:00:00Z'
      }
    ]
  ]);

  return seed;
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
