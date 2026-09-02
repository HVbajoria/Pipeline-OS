import {
  currentBookedInterview,
  currentInterviewProposals,
  materializeInterviewProposals,
  bookInterviewSlot
} from '../../shared/domain/interviewWorkflow';
import { workflowStageForStatus, calculateRecruitingWorkflowStatus } from '../../shared/domain/workflowStatus';
import { conflictError, notFoundError } from '../../shared/errors';
import type { InterviewPanel, Timestamp } from '../../shared/models';
import {
  MAX_APPROVAL_SUMMARY_ITEMS,
  type CoordinateInterviewWorkflowOutput
} from '../../shared/operations';
import { assertEnum, assertRecordId, assertTimestamp } from '../../shared/validators';
import type {
  OperationHandler,
  OperationHandlerContext
} from '../operationService';
import { commonFreeSlotsForPanelCalendars } from './panelAvailability';

const INTERVIEW_ACTIONS = ['propose_slots', 'book_slot'] as const;

type InterviewAction = (typeof INTERVIEW_ACTIONS)[number];

function boundedText(value: string, maximum = 300): string {
  const trimmed = value.trim();
  return trimmed.length <= maximum
    ? trimmed
    : `${trimmed.slice(0, Math.max(1, maximum - 1))}…`;
}

function boundedStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
    .slice(0, MAX_APPROVAL_SUMMARY_ITEMS)
    .map((value) => boundedText(value));
}

function panelForJob(
  context: OperationHandlerContext<'coordinate_interview_workflow'>,
  jobId: string
): InterviewPanel | undefined {
  return [...context.state.panels.values()].find((panel) => panel.jobId === jobId);
}


export const coordinateInterviewWorkflow: OperationHandler<
  'coordinate_interview_workflow'
> = (input, context): CoordinateInterviewWorkflowOutput => {
  const applicationId = assertRecordId(input.applicationId, 'applicationId');
  const action = assertEnum(input.action, INTERVIEW_ACTIONS, 'action') as InterviewAction;
  const application = context.state.applications.get(applicationId);

  if (application === undefined) {
    throw notFoundError(`Application ${applicationId} was not found`, {
      recordType: 'Application_Record',
      recordId: applicationId,
      field: 'applicationId'
    });
  }

  const job = context.state.jobs.get(application.jobId);
  if (job === undefined) {
    throw notFoundError(`Job ${application.jobId} was not found`, {
      recordType: 'Job_Requisition',
      recordId: application.jobId,
      field: 'jobId'
    });
  }

  const panel = panelForJob(context, job.id);
  if (panel === undefined) {
    throw notFoundError(`Interview panel for job ${job.id} was not found`, {
      recordType: 'Interview_Panel',
      recordId: job.id,
      field: 'applicationId'
    });
  }

  if (action === 'propose_slots') {
    if (application.status !== 'screened') {
      throw conflictError(
        `Application ${application.id} must be screened before interview slots can be proposed`,
        {
          recordType: 'Application_Record',
          recordId: application.id,
          field: 'status',
          status: application.status,
          toStatus: 'interviewing'
        }
      );
    }

    const span = context.trace.startChild('interview.propose_slots', {
      applicationId,
      panelId: panel.id
    });
    try {
      materializeInterviewProposals(
        application,
        panel,
        commonFreeSlotsForPanelCalendars(context.state, panel),
        context.state.interviews,
        () => context.nextId('interview'),
        { reuseExisting: true }
      );
      context.trace.completeSpan(span, 'completed', {
        proposalCount: currentInterviewProposals(
          context.state.interviews.values(),
          applicationId,
          panel.id
        ).length
      });
    } catch (error) {
      context.trace.completeSpan(span, 'failed');
      throw error;
    }
  } else {
    const slot = assertTimestamp(input.slot, 'slot') as Timestamp;
    const span = context.trace.startChild('interview.book_slot', {
      applicationId,
      panelId: panel.id
    });
    try {
      bookInterviewSlot(
        application,
        context.state.interviews,
        slot,
        { allowAlreadyBooked: true, panelId: panel.id }
      );
      context.trace.completeSpan(span, 'completed', { slot });
    } catch (error) {
      context.trace.completeSpan(span, 'failed');
      throw error;
    }
  }

  const projection = calculateRecruitingWorkflowStatus(
    context.state,
    { applicationId },
    { generatedAt: context.now(), limit: 1 }
  );
  const summary = projection.applications[0];
  const proposed = currentInterviewProposals(
    context.state.interviews.values(),
    applicationId,
    panel.id
  );
  const booked = currentBookedInterview(
    context.state.interviews.values(),
    applicationId,
    panel.id
  );

  return {
    applicationId,
    stage: boundedText(
      summary?.currentStage ?? workflowStageForStatus(application.status),
      100
    ),
    proposedSlots: proposed.slice(0, 3).map((interview) => ({
      interviewId: interview.id,
      slot: interview.slot
    })),
    bookedInterview:
      booked === undefined
        ? null
        : { interviewId: booked.id, slot: booked.slot },
    nextAction:
      summary?.nextActions[0] === undefined
        ? null
        : boundedText(summary.nextActions[0]),
    blockers: boundedStrings(summary?.blockers ?? projection.blockers)
  };
};

export const coordinateInterviewWorkflowHandler = coordinateInterviewWorkflow;
export default coordinateInterviewWorkflow;
