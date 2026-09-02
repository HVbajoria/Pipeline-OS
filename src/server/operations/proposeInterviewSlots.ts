/** Mutation handler for materializing the best common interview slots. */

import { notFoundError } from '../../shared/errors';
import { materializeInterviewProposals } from '../../shared/domain/interviewWorkflow';
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

  const result = materializeInterviewProposals(
    application,
    panel,
    commonFreeSlotsForPanelCalendars(context.state, panel),
    context.state.interviews,
    () => context.nextId('interview'),
    { reuseExisting: false }
  );

  return {
    proposedSlots: result.records.map(({ id: interviewId, slot }) => ({
      interviewId,
      slot
    }))
  };
};

export const proposeInterviewSlotsHandler = proposeInterviewSlots;
export default proposeInterviewSlots;
