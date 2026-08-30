/** Mutation handler for materializing the best common interview slots. */

import { notFoundError } from '../../shared/errors';
import { selectTopThreeSlots } from '../../shared/domain/scheduling';
import type {
  InterviewRecord
} from '../../shared/models';
import type {
  ProposeInterviewSlotsOutput
} from '../../shared/operations';
import { assertRecordId } from '../../shared/validators';
import type { OperationHandler } from '../operationService';
import { commonFreeSlotsForPanelCalendars } from './panelAvailability';

export const proposeInterviewSlots: OperationHandler<
  'propose_interview_slots'
> = (input, context): ProposeInterviewSlotsOutput => {
  const applicationId = assertRecordId(input.applicationId, 'applicationId');
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

  const panel = [...context.state.panels.values()].find(
    (candidatePanel) => candidatePanel.jobId === job.id
  );
  if (panel === undefined) {
    throw notFoundError(`Interview panel for job ${job.id} was not found`, {
      recordType: 'Interview_Panel',
      recordId: job.id,
      field: 'applicationId'
    });
  }

  const commonSlots = selectTopThreeSlots(
    commonFreeSlotsForPanelCalendars(context.state, panel)
  );
  const proposedSlots: ProposeInterviewSlotsOutput['proposedSlots'] = [];

  for (const slot of commonSlots) {
    let interviewId = context.nextId('interview');
    while (context.state.interviews.has(interviewId)) {
      interviewId = context.nextId('interview');
    }

    const interview: InterviewRecord = {
      id: interviewId,
      applicationId: application.id,
      panelId: panel.id,
      slot,
      status: 'proposed'
    };
    context.state.interviews.set(interviewId, interview);
    proposedSlots.push({ interviewId, slot });
  }

  return { proposedSlots };
};

export const proposeInterviewSlotsHandler = proposeInterviewSlots;
export default proposeInterviewSlots;
