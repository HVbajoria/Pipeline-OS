/** Read-only job discovery for UI and agent clients that need a valid job ID. */

import type { OperationHandler } from '../operationService';
import type {
  ListOpenJobsInput,
  ListOpenJobsOutput,
  OpenJobSummary
} from '../../shared/operations';

export const listOpenJobs: OperationHandler<'list_open_jobs'> = (
  _input: ListOpenJobsInput,
  context
): ListOpenJobsOutput => {
  const jobs: OpenJobSummary[] = [...context.state.jobs.values()]
    .filter((job) => job.status === 'open')
    .map((job) => ({
      jobId: job.id,
      title: job.title,
      department: job.department,
      requirements: [...job.requirements],
      compBand: { ...job.compBand }
    }));

  return { jobs };
};

export default listOpenJobs;
