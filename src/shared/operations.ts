/**
 * Canonical operation contracts shared by the server, UI client, and WebMCP
 * adapters.  This module is intentionally free of runtime/framework
 * dependencies so the same schemas can be used at every boundary.
 */

import type {
  ApplicationRecord,
  BackgroundCheckStatus,
  CandidateRecord,
  CompensationBand,
  DateRange,
  ExperienceLevel,
  InterviewRecommendation,
  JobRequisition,
  OfferDecision,
  OfferResponseStatus,
  PlanSelections,
  ScorecardRecord,
  ScorecardRecommendation,
  StartDate,
  TaskCompletion,
  Timestamp
} from './models';
import {
  BACKGROUND_CHECK_STATUSES,
  EXPERIENCE_LEVELS,
  OFFER_DECISIONS,
  OFFER_RESPONSE_STATUSES,
  SCORECARD_RECOMMENDATIONS
} from './models';

/** A JSON Schema type supported by the shared validator. */
export type JsonSchemaType =
  | 'array'
  | 'boolean'
  | 'integer'
  | 'null'
  | 'number'
  | 'object'
  | 'string';

/**
 * The subset of JSON Schema needed by PipelineOS operation contracts.  The
 * shape deliberately remains JSON-serializable so it can be handed directly
 * to a WebMCP runtime.
 */
export interface JsonSchema {
  $schema?: string;
  title?: string;
  description?: string;
  type?: JsonSchemaType | readonly JsonSchemaType[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  oneOf?: readonly JsonSchema[];
  anyOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  maxProperties?: number;
}

/** Common spelling used by WebMCP/JSON Schema integrations. */
export type JSONSchema = JsonSchema;

/** The exact set of operations exposed by PipelineOS. */
export const OPERATION_NAMES = [
  'create_job_requisition',
  'search_candidates',
  'get_candidate_profile',
  'submit_application',
  'screen_candidate',
  'answer_candidate_faq',
  'check_interviewer_availability',
  'propose_interview_slots',
  'book_interview',
  'get_interview_kit',
  'submit_interview_feedback',
  'get_panel_feedback_summary',
  'generate_offer',
  'send_offer',
  'respond_to_offer',
  'initiate_background_check',
  'enroll_benefits',
  'generate_onboarding_checklist',
  'get_onboarding_status'
] as const;

export type OperationName = (typeof OPERATION_NAMES)[number];

/** Stable implementation keys used by the server operation dispatcher. */
export const OPERATION_IMPLEMENTATION_KEYS = {
  create_job_requisition: 'createJobRequisition',
  search_candidates: 'searchCandidates',
  get_candidate_profile: 'getCandidateProfile',
  submit_application: 'submitApplication',
  screen_candidate: 'screenCandidate',
  answer_candidate_faq: 'answerCandidateFaq',
  check_interviewer_availability: 'checkInterviewerAvailability',
  propose_interview_slots: 'proposeInterviewSlots',
  book_interview: 'bookInterview',
  get_interview_kit: 'getInterviewKit',
  submit_interview_feedback: 'submitInterviewFeedback',
  get_panel_feedback_summary: 'getPanelFeedbackSummary',
  generate_offer: 'generateOffer',
  send_offer: 'sendOffer',
  respond_to_offer: 'respondToOffer',
  initiate_background_check: 'initiateBackgroundCheck',
  enroll_benefits: 'enrollBenefits',
  generate_onboarding_checklist: 'generateOnboardingChecklist',
  get_onboarding_status: 'getOnboardingStatus'
} as const satisfies { readonly [N in OperationName]: string };

export type OperationImplementationKey =
  (typeof OPERATION_IMPLEMENTATION_KEYS)[OperationName];

// ---------------------------------------------------------------------------
// Operation input and output contracts
// ---------------------------------------------------------------------------

export interface CreateJobRequisitionInput {
  title: string;
  department: string;
  requirements: string[];
  compBand: CompensationBand;
}

export interface CreateJobRequisitionOutput {
  jobId: string;
}

export interface SearchCandidatesInput {
  query?: string;
  skills?: string[];
  experienceLevel?: ExperienceLevel;
}

export interface CandidateSearchResult {
  candidateId: string;
  name: string;
  matchScore: number;
  rationale: string;
}

export interface SearchCandidatesOutput {
  results: CandidateSearchResult[];
}

export interface GetCandidateProfileInput {
  candidateId: string;
}

export type GetCandidateProfileOutput = CandidateRecord & {
  applicationHistory: ApplicationRecord[];
};

export interface SubmitApplicationInput {
  candidateId: string;
  jobId: string;
  resumeText: string;
}

export interface SubmitApplicationOutput {
  applicationId: string;
  status: 'applied';
}

export interface ScreenCandidateInput {
  applicationId: string;
}

export interface ScreenCandidateOutput {
  applicationId: string;
  screeningScore: number;
  screeningRationale: string;
  status: 'screened';
}

export interface AnswerCandidateFaqInput {
  jobId: string;
  question: string;
}

export interface AnswerCandidateFaqOutput {
  answer: string;
  answeredFromData: boolean;
}

export interface CheckInterviewerAvailabilityInput {
  panelId: string;
  dateRange: DateRange;
}

export interface CheckInterviewerAvailabilityOutput {
  commonFreeSlots: Timestamp[];
}

export interface ProposeInterviewSlotsInput {
  applicationId: string;
}

export interface ProposedInterviewSlot {
  interviewId: string;
  slot: Timestamp;
}

export interface ProposeInterviewSlotsOutput {
  proposedSlots: ProposedInterviewSlot[];
}

export interface BookInterviewInput {
  applicationId: string;
  slot: Timestamp;
}

export interface BookInterviewOutput {
  interviewId: string;
  status: 'booked';
}

export interface GetInterviewKitInput {
  jobId: string;
}

export interface InterviewKitCompetency {
  name: string;
  questions: string[];
}

export interface GetInterviewKitOutput {
  competencies: InterviewKitCompetency[];
}

export interface SubmitInterviewFeedbackInput {
  interviewId: string;
  interviewer: string;
  competencyScores: Record<string, number>;
  recommendation: InterviewRecommendation;
  comments: string;
}

export interface SubmitInterviewFeedbackOutput {
  scorecardId: string;
}

export interface GetPanelFeedbackSummaryInput {
  applicationId: string;
}

export type RecommendationTally = Partial<
  Record<ScorecardRecommendation, number>
>;

export interface GetPanelFeedbackSummaryOutput {
  averageScores: Record<string, number>;
  recommendationTally: RecommendationTally;
  scorecards: ScorecardRecord[];
}

export interface GenerateOfferInput {
  applicationId: string;
  compAmount: number;
}

export interface GenerateOfferOutput {
  offerId: string;
  status: 'draft';
}

export interface SendOfferInput {
  offerId: string;
}

export interface SendOfferOutput {
  offerId: string;
  status: 'sent';
}

export type RespondToOfferInput =
  | {
      offerId: string;
      decision: Extract<OfferDecision, 'accept' | 'decline'>;
      counterAmount?: number;
    }
  | {
      offerId: string;
      decision: Extract<OfferDecision, 'counter'>;
      counterAmount: number;
    };

export interface RespondToOfferOutput {
  offerId: string;
  status: OfferResponseStatus;
}

export interface InitiateBackgroundCheckInput {
  offerId: string;
}

/** Background checks are returned before/after the deterministic clear step. */
export interface InitiateBackgroundCheckOutput {
  backgroundCheckId: string;
  status: Extract<BackgroundCheckStatus, 'pending' | 'clear'>;
}

export interface EnrollBenefitsInput {
  offerId: string;
  planSelections: PlanSelections;
}

export interface EnrollBenefitsOutput {
  enrollmentId: string;
}

export interface GenerateOnboardingChecklistInput {
  offerId: string;
}

export interface OnboardingTaskSummary {
  taskId: string;
  taskName: string;
  dueDate: Timestamp;
}

export interface GenerateOnboardingChecklistOutput {
  tasks: OnboardingTaskSummary[];
}

export interface GetOnboardingStatusInput {
  offerId: string;
}

export interface GetOnboardingStatusOutput {
  backgroundCheckStatus: BackgroundCheckStatus | null;
  benefitsEnrolled: boolean;
  taskCompletion: TaskCompletion;
  completionPercentage: number;
}

/** Input types indexed by the canonical operation name. */
export interface OperationInputMap {
  create_job_requisition: CreateJobRequisitionInput;
  search_candidates: SearchCandidatesInput;
  get_candidate_profile: GetCandidateProfileInput;
  submit_application: SubmitApplicationInput;
  screen_candidate: ScreenCandidateInput;
  answer_candidate_faq: AnswerCandidateFaqInput;
  check_interviewer_availability: CheckInterviewerAvailabilityInput;
  propose_interview_slots: ProposeInterviewSlotsInput;
  book_interview: BookInterviewInput;
  get_interview_kit: GetInterviewKitInput;
  submit_interview_feedback: SubmitInterviewFeedbackInput;
  get_panel_feedback_summary: GetPanelFeedbackSummaryInput;
  generate_offer: GenerateOfferInput;
  send_offer: SendOfferInput;
  respond_to_offer: RespondToOfferInput;
  initiate_background_check: InitiateBackgroundCheckInput;
  enroll_benefits: EnrollBenefitsInput;
  generate_onboarding_checklist: GenerateOnboardingChecklistInput;
  get_onboarding_status: GetOnboardingStatusInput;
}

/** Output types indexed by the canonical operation name. */
export interface OperationOutputMap {
  create_job_requisition: CreateJobRequisitionOutput;
  search_candidates: SearchCandidatesOutput;
  get_candidate_profile: GetCandidateProfileOutput;
  submit_application: SubmitApplicationOutput;
  screen_candidate: ScreenCandidateOutput;
  answer_candidate_faq: AnswerCandidateFaqOutput;
  check_interviewer_availability: CheckInterviewerAvailabilityOutput;
  propose_interview_slots: ProposeInterviewSlotsOutput;
  book_interview: BookInterviewOutput;
  get_interview_kit: GetInterviewKitOutput;
  submit_interview_feedback: SubmitInterviewFeedbackOutput;
  get_panel_feedback_summary: GetPanelFeedbackSummaryOutput;
  generate_offer: GenerateOfferOutput;
  send_offer: SendOfferOutput;
  respond_to_offer: RespondToOfferOutput;
  initiate_background_check: InitiateBackgroundCheckOutput;
  enroll_benefits: EnrollBenefitsOutput;
  generate_onboarding_checklist: GenerateOnboardingChecklistOutput;
  get_onboarding_status: GetOnboardingStatusOutput;
}

/** A WebMCP-compatible descriptor for one shared operation. */
export interface OperationDescriptor<N extends OperationName = OperationName> {
  name: N;
  description: string;
  /** Server-side annotation used by clients and documentation. */
  readOnly: boolean;
  /** WebMCP annotation name used by native runtimes. */
  readOnlyHint: boolean;
  annotations: {
    readOnlyHint: boolean;
  };
  implementationKey: OperationImplementationKey;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

export type OperationRegistry = {
  readonly [N in OperationName]: OperationDescriptor<N>;
};

// ---------------------------------------------------------------------------
// Shared JSON Schema descriptors
// ---------------------------------------------------------------------------

const idSchema: JsonSchema = {
  type: 'string',
  minLength: 1
};

const requiredStringSchema: JsonSchema = {
  type: 'string',
  minLength: 1
};

const timestampSchema: JsonSchema = {
  type: 'string',
  minLength: 1,
  format: 'date-time'
};

const compensationBandSchema: JsonSchema = {
  type: 'object',
  properties: {
    min: { type: 'number' },
    max: { type: 'number' },
    currency: requiredStringSchema
  },
  required: ['min', 'max', 'currency'],
  additionalProperties: false
};

const dateRangeSchema: JsonSchema = {
  type: 'object',
  properties: {
    start: timestampSchema,
    end: timestampSchema
  },
  required: ['start', 'end'],
  additionalProperties: false
};

const candidateRecordSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: idSchema,
    name: requiredStringSchema,
    email: requiredStringSchema,
    resumeText: requiredStringSchema,
    skills: {
      type: 'array',
      items: requiredStringSchema
    },
    experienceYears: {
      type: 'number',
      minimum: 0
    },
    resumeTextHistory: {
      type: 'array',
      items: requiredStringSchema
    }
  },
  required: [
    'id',
    'name',
    'email',
    'resumeText',
    'skills',
    'experienceYears',
    'resumeTextHistory'
  ],
  additionalProperties: false
};

const applicationRecordSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: idSchema,
    candidateId: idSchema,
    jobId: idSchema,
    status: {
      type: 'string',
      enum: [
        'applied',
        'screened',
        'interviewing',
        'offer_sent',
        'offer_accepted',
        'offer_declined',
        'rejected',
        'onboarding'
      ]
    },
    screeningScore: { type: ['number', 'null'] as const },
    screeningRationale: { type: ['string', 'null'] as const },
    notes: { type: 'array' },
    createdAt: timestampSchema
  },
  required: [
    'id',
    'candidateId',
    'jobId',
    'status',
    'screeningScore',
    'screeningRationale',
    'notes',
    'createdAt'
  ],
  additionalProperties: false
};

const scorecardRecordSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: idSchema,
    interviewId: idSchema,
    interviewer: requiredStringSchema,
    competencyScores: {
      type: 'object',
      additionalProperties: {
        type: 'number',
        minimum: 1,
        maximum: 5
      }
    },
    recommendation: {
      type: 'string',
      enum: SCORECARD_RECOMMENDATIONS
    },
    comments: requiredStringSchema,
    submittedAt: timestampSchema
  },
  required: [
    'id',
    'interviewId',
    'interviewer',
    'competencyScores',
    'recommendation',
    'comments',
    'submittedAt'
  ],
  additionalProperties: false
};

const competencySchema: JsonSchema = {
  type: 'object',
  properties: {
    name: requiredStringSchema,
    questions: {
      type: 'array',
      minItems: 1,
      items: requiredStringSchema
    }
  },
  required: ['name', 'questions'],
  additionalProperties: false
};

const operationDescriptor = <N extends OperationName>(
  name: N,
  description: string,
  readOnly: boolean,
  inputSchema: JsonSchema,
  outputSchema: JsonSchema
): OperationDescriptor<N> => ({
  name,
  description,
  readOnly,
  readOnlyHint: readOnly,
  annotations: { readOnlyHint: readOnly },
  implementationKey: OPERATION_IMPLEMENTATION_KEYS[name],
  inputSchema,
  outputSchema
});

/**
 * The one canonical registry.  Both the server validator and WebMCP adapter
 * must consume these descriptors rather than maintaining local schemas.
 */
export const OPERATION_REGISTRY = {
  create_job_requisition: operationDescriptor(
    'create_job_requisition',
    'Create a job requisition for an open role.',
    false,
    {
      type: 'object',
      properties: {
        title: requiredStringSchema,
        department: requiredStringSchema,
        requirements: {
          type: 'array',
          minItems: 1,
          items: requiredStringSchema
        },
        compBand: compensationBandSchema
      },
      required: ['title', 'department', 'requirements', 'compBand'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { jobId: idSchema },
      required: ['jobId'],
      additionalProperties: false
    }
  ),

  search_candidates: operationDescriptor(
    'search_candidates',
    'Search and rank candidates by skills, keywords, and experience level.',
    true,
    {
      type: 'object',
      properties: {
        query: { type: 'string' },
        skills: {
          type: 'array',
          items: requiredStringSchema
        },
        experienceLevel: {
          type: 'string',
          enum: EXPERIENCE_LEVELS
        }
      },
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              candidateId: idSchema,
              name: requiredStringSchema,
              matchScore: { type: 'number', minimum: 0 },
              rationale: requiredStringSchema
            },
            required: ['candidateId', 'name', 'matchScore', 'rationale'],
            additionalProperties: false
          }
        }
      },
      required: ['results'],
      additionalProperties: false
    }
  ),

  get_candidate_profile: operationDescriptor(
    'get_candidate_profile',
    'Get a complete candidate profile and application history.',
    true,
    {
      type: 'object',
      properties: { candidateId: idSchema },
      required: ['candidateId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        ...candidateRecordSchema.properties,
        applicationHistory: {
          type: 'array',
          items: applicationRecordSchema
        }
      },
      required: [
        'id',
        'name',
        'email',
        'resumeText',
        'skills',
        'experienceYears',
        'resumeTextHistory',
        'applicationHistory'
      ],
      additionalProperties: false
    }
  ),

  submit_application: operationDescriptor(
    'submit_application',
    'Submit a candidate application to an open job.',
    false,
    {
      type: 'object',
      properties: {
        candidateId: idSchema,
        jobId: idSchema,
        resumeText: requiredStringSchema
      },
      required: ['candidateId', 'jobId', 'resumeText'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        applicationId: idSchema,
        status: { type: 'string', const: 'applied' }
      },
      required: ['applicationId', 'status'],
      additionalProperties: false
    }
  ),

  screen_candidate: operationDescriptor(
    'screen_candidate',
    'Calculate and persist an explainable candidate screening score.',
    false,
    {
      type: 'object',
      properties: { applicationId: idSchema },
      required: ['applicationId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        applicationId: idSchema,
        screeningScore: { type: 'number', minimum: 0, maximum: 100 },
        screeningRationale: requiredStringSchema,
        status: { type: 'string', const: 'screened' }
      },
      required: [
        'applicationId',
        'screeningScore',
        'screeningRationale',
        'status'
      ],
      additionalProperties: false
    }
  ),

  answer_candidate_faq: operationDescriptor(
    'answer_candidate_faq',
    'Answer a candidate question using only requisition data.',
    true,
    {
      type: 'object',
      properties: {
        jobId: idSchema,
        question: requiredStringSchema
      },
      required: ['jobId', 'question'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        answer: requiredStringSchema,
        answeredFromData: { type: 'boolean' }
      },
      required: ['answer', 'answeredFromData'],
      additionalProperties: false
    }
  ),

  check_interviewer_availability: operationDescriptor(
    'check_interviewer_availability',
    'Find common free interview slots for every interviewer on a panel.',
    true,
    {
      type: 'object',
      properties: {
        panelId: idSchema,
        dateRange: dateRangeSchema
      },
      required: ['panelId', 'dateRange'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        commonFreeSlots: {
          type: 'array',
          items: timestampSchema
        }
      },
      required: ['commonFreeSlots'],
      additionalProperties: false
    }
  ),

  propose_interview_slots: operationDescriptor(
    'propose_interview_slots',
    'Propose up to three common interview slots for an application.',
    false,
    {
      type: 'object',
      properties: { applicationId: idSchema },
      required: ['applicationId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        proposedSlots: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              interviewId: idSchema,
              slot: timestampSchema
            },
            required: ['interviewId', 'slot'],
            additionalProperties: false
          }
        }
      },
      required: ['proposedSlots'],
      additionalProperties: false
    }
  ),

  book_interview: operationDescriptor(
    'book_interview',
    'Book a proposed interview slot and cancel its sibling proposals.',
    false,
    {
      type: 'object',
      properties: {
        applicationId: idSchema,
        slot: timestampSchema
      },
      required: ['applicationId', 'slot'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        interviewId: idSchema,
        status: { type: 'string', const: 'booked' }
      },
      required: ['interviewId', 'status'],
      additionalProperties: false
    }
  ),

  get_interview_kit: operationDescriptor(
    'get_interview_kit',
    'Get the static competency-based interview kit for a role.',
    true,
    {
      type: 'object',
      properties: { jobId: idSchema },
      required: ['jobId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        competencies: {
          type: 'array',
          minItems: 3,
          maxItems: 4,
          items: competencySchema
        }
      },
      required: ['competencies'],
      additionalProperties: false
    }
  ),

  submit_interview_feedback: operationDescriptor(
    'submit_interview_feedback',
    'Submit a structured interviewer scorecard.',
    false,
    {
      type: 'object',
      properties: {
        interviewId: idSchema,
        interviewer: requiredStringSchema,
        competencyScores: {
          type: 'object',
          minProperties: 1,
          additionalProperties: {
            type: 'number',
            minimum: 1,
            maximum: 5
          }
        },
        recommendation: {
          type: 'string',
          enum: SCORECARD_RECOMMENDATIONS
        },
        comments: requiredStringSchema
      },
      required: [
        'interviewId',
        'interviewer',
        'competencyScores',
        'recommendation',
        'comments'
      ],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { scorecardId: idSchema },
      required: ['scorecardId'],
      additionalProperties: false
    }
  ),

  get_panel_feedback_summary: operationDescriptor(
    'get_panel_feedback_summary',
    'Summarize panel scorecards for an application.',
    true,
    {
      type: 'object',
      properties: { applicationId: idSchema },
      required: ['applicationId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        averageScores: {
          type: 'object',
          additionalProperties: { type: 'number' }
        },
        recommendationTally: {
          type: 'object',
          properties: {
            strong_yes: { type: 'number', minimum: 0 },
            yes: { type: 'number', minimum: 0 },
            no: { type: 'number', minimum: 0 },
            strong_no: { type: 'number', minimum: 0 }
          },
          additionalProperties: false
        },
        scorecards: {
          type: 'array',
          items: scorecardRecordSchema
        }
      },
      required: ['averageScores', 'recommendationTally', 'scorecards'],
      additionalProperties: false
    }
  ),

  generate_offer: operationDescriptor(
    'generate_offer',
    'Generate a draft compensation offer for an application.',
    false,
    {
      type: 'object',
      properties: {
        applicationId: idSchema,
        compAmount: { type: 'number', minimum: 0 }
      },
      required: ['applicationId', 'compAmount'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        offerId: idSchema,
        status: { type: 'string', const: 'draft' }
      },
      required: ['offerId', 'status'],
      additionalProperties: false
    }
  ),

  send_offer: operationDescriptor(
    'send_offer',
    'Send a drafted offer to its candidate.',
    false,
    {
      type: 'object',
      properties: { offerId: idSchema },
      required: ['offerId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        offerId: idSchema,
        status: { type: 'string', const: 'sent' }
      },
      required: ['offerId', 'status'],
      additionalProperties: false
    }
  ),

  respond_to_offer: operationDescriptor(
    'respond_to_offer',
    'Accept, decline, or counter a sent offer.',
    false,
    {
      type: 'object',
      properties: {
        offerId: idSchema,
        decision: {
          type: 'string',
          enum: OFFER_DECISIONS
        },
        counterAmount: { type: 'number', minimum: 0 }
      },
      required: ['offerId', 'decision'],
      additionalProperties: false,
      oneOf: [
        {
          type: 'object',
          properties: {
            decision: {
              type: 'string',
              enum: ['accept', 'decline']
            }
          },
          required: ['decision']
        },
        {
          type: 'object',
          properties: {
            decision: { type: 'string', const: 'counter' },
            counterAmount: { type: 'number', minimum: 0 }
          },
          required: ['decision', 'counterAmount']
        }
      ]
    },
    {
      type: 'object',
      properties: {
        offerId: idSchema,
        status: {
          type: 'string',
          enum: OFFER_RESPONSE_STATUSES
        }
      },
      required: ['offerId', 'status'],
      additionalProperties: false
    }
  ),

  initiate_background_check: operationDescriptor(
    'initiate_background_check',
    'Initiate the deterministic background-check workflow for an accepted offer.',
    false,
    {
      type: 'object',
      properties: { offerId: idSchema },
      required: ['offerId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        backgroundCheckId: idSchema,
        status: { type: 'string', enum: ['pending', 'clear'] }
      },
      required: ['backgroundCheckId', 'status'],
      additionalProperties: false
    }
  ),

  enroll_benefits: operationDescriptor(
    'enroll_benefits',
    'Enroll an offer in the selected medical, dental, and vision plans.',
    false,
    {
      type: 'object',
      properties: {
        offerId: idSchema,
        planSelections: {
          type: 'object',
          properties: {
            medical: requiredStringSchema,
            dental: requiredStringSchema,
            vision: requiredStringSchema
          },
          required: ['medical', 'dental', 'vision'],
          additionalProperties: false
        }
      },
      required: ['offerId', 'planSelections'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { enrollmentId: idSchema },
      required: ['enrollmentId'],
      additionalProperties: false
    }
  ),

  generate_onboarding_checklist: operationDescriptor(
    'generate_onboarding_checklist',
    'Generate the role-specific onboarding checklist for an accepted offer.',
    false,
    {
      type: 'object',
      properties: { offerId: idSchema },
      required: ['offerId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              taskId: idSchema,
              taskName: requiredStringSchema,
              dueDate: timestampSchema
            },
            required: ['taskId', 'taskName', 'dueDate'],
            additionalProperties: false
          }
        }
      },
      required: ['tasks'],
      additionalProperties: false
    }
  ),

  get_onboarding_status: operationDescriptor(
    'get_onboarding_status',
    'Get consolidated background-check, benefits, and task progress.',
    true,
    {
      type: 'object',
      properties: { offerId: idSchema },
      required: ['offerId'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        backgroundCheckStatus: {
          type: ['string', 'null'] as const,
          enum: [...BACKGROUND_CHECK_STATUSES, null]
        },
        benefitsEnrolled: { type: 'boolean' },
        taskCompletion: {
          type: 'object',
          properties: {
            done: { type: 'number', minimum: 0 },
            total: { type: 'number', minimum: 0 }
          },
          required: ['done', 'total'],
          additionalProperties: false
        },
        completionPercentage: { type: 'number', minimum: 0, maximum: 100 }
      },
      required: [
        'backgroundCheckStatus',
        'benefitsEnrolled',
        'taskCompletion',
        'completionPercentage'
      ],
      additionalProperties: false
    }
  )
} as const satisfies OperationRegistry;

/** Alias with a descriptive lower-case name for consumers that prefer it. */
export const operationRegistry = OPERATION_REGISTRY;
export const OPERATION_DESCRIPTORS = OPERATION_REGISTRY;
export const OPERATIONS = OPERATION_REGISTRY;

export function isOperationName(value: unknown): value is OperationName {
  return (
    typeof value === 'string' &&
    (OPERATION_NAMES as readonly string[]).includes(value)
  );
}

export function getOperationDescriptor<N extends OperationName>(
  name: N
): OperationDescriptor<N> {
  return OPERATION_REGISTRY[name] as OperationDescriptor<N>;
}

export function getOperationNames(): OperationName[] {
  return [...OPERATION_NAMES];
}

/** Compile-time helper for code that dispatches by operation name. */
export type OperationInput<N extends OperationName> = OperationInputMap[N];
export type OperationOutput<N extends OperationName> = OperationOutputMap[N];

// Keep these imports type-visible to consumers that use the operation module
// as their single contract entry point.
export type {
  ApplicationRecord,
  BackgroundCheckStatus,
  CandidateRecord,
  CompensationBand,
  DateRange,
  ExperienceLevel,
  JobRequisition,
  OfferDecision,
  OfferResponseStatus,
  PlanSelections,
  ScorecardRecord,
  ScorecardRecommendation,
  StartDate,
  TaskCompletion,
  Timestamp
};
