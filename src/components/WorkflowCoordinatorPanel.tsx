import { useState } from 'react';
import { operationClient } from '../client/operationClient';
import { useStore } from '../lib/store';
import { PipelineError } from '../shared/errors';
import type {
  ActorContext,
  ApplicationRecord,
  OfferRecord,
  OnboardingTaskRecord
} from '../shared/models';
import type {
  CoordinateInterviewWorkflowOutput,
  CoordinateOnboardingWorkflowOutput
} from '../shared/operations';

export interface WorkflowCoordinatorPanelProps {
  actor: ActorContext;
  role?: string;
}

function errorMessage(error: unknown): string {
  const pipelineError = PipelineError.from(error);
  if (pipelineError.code === 'FORBIDDEN_ERROR') {
    return 'This actor is not permitted to coordinate this workflow.';
  }
  return pipelineError.message;
}

function applicationTasks(
  tasks: readonly OnboardingTaskRecord[],
  offer: OfferRecord
): OnboardingTaskRecord[] {
  return tasks.filter((task) => task.offerId === offer.id);
}

function interviewApplications(applications: readonly ApplicationRecord[]) {
  return applications.filter(
    (application) => application.status === 'screened' || application.status === 'interviewing'
  );
}

/**
 * High-level recruiter workflow controls. Every action uses the canonical
 * coordinator operation and renders its server result after OperationClient's
 * authoritative refresh; no local domain record is mutated here.
 */
export default function WorkflowCoordinatorPanel({
  actor,
  role = 'recruiter'
}: WorkflowCoordinatorPanelProps) {
  const applications = useStore((state) => state.applications);
  const offers = useStore((state) => state.offers);
  const interviews = useStore((state) => state.interviews);
  const onboardingTasks = useStore((state) => state.onboardingTasks);
  const candidates = useStore((state) => state.candidates);
  const [interviewResults, setInterviewResults] = useState<
    Record<string, CoordinateInterviewWorkflowOutput>
  >({});
  const [onboardingResults, setOnboardingResults] = useState<
    Record<string, CoordinateOnboardingWorkflowOutput>
  >({});
  const [error, setError] = useState<string | null>(null);

  const run = async (operation: () => Promise<unknown>) => {
    try {
      setError(null);
      return await operation();
    } catch (caught) {
      setError(errorMessage(caught));
      return undefined;
    }
  };

  const coordinateInterview = async (
    applicationId: string,
    action: 'propose_slots' | 'book_slot',
    slot?: string
  ) => {
    const result = await run(() =>
      operationClient.invoke(
        'coordinate_interview_workflow',
        { applicationId, action, ...(slot === undefined ? {} : { slot }) },
        { actor }
      )
    );
    if (result) {
      setInterviewResults((previous) => ({
        ...previous,
        [applicationId]: result as CoordinateInterviewWorkflowOutput
      }));
    }
  };

  const coordinateOnboarding = async (
    offerId: string,
    action: 'initialize_checklist' | 'update_task',
    taskId?: string,
    status?: 'pending' | 'in_progress' | 'complete'
  ) => {
    const result = await run(() =>
      operationClient.invoke(
        'coordinate_onboarding_workflow',
        {
          offerId,
          action,
          ...(taskId === undefined ? {} : { taskId }),
          ...(status === undefined ? {} : { status })
        },
        { actor }
      )
    );
    if (result) {
      setOnboardingResults((previous) => ({
        ...previous,
        [offerId]: result as CoordinateOnboardingWorkflowOutput
      }));
    }
  };

  const candidateName = (candidateId: string) =>
    candidates.find((candidate) => candidate.id === candidateId)?.name ?? candidateId;

  return (
    <section
      aria-label="Workflow coordinators"
      data-workflow-coordinators
      data-workflow-role={role}
      className="panel panel--padded space-y-5"
    >
      <div>
        <h2 className="text-lg font-semibold">Workflow coordinators</h2>
        <p className="text-sm text-gray-500">
          Coordinate interview proposals, bookings, onboarding checklists, and task status through the canonical operation path.
        </p>
      </div>
      {error && (
        <div data-workflow-coordinator-error className="callout callout--danger">
          {error}
        </div>
      )}

      <div data-interview-coordinator className="space-y-3">
        <h3 className="font-medium text-gray-800">Interview workflow</h3>
        {interviewApplications(applications).length === 0 ? (
          <p className="text-xs text-gray-400">No screened or interviewing applications.</p>
        ) : (
          interviewApplications(applications).map((application) => {
            const result = interviewResults[application.id];
            const proposed = interviews
              .filter(
                (interview) =>
                  interview.applicationId === application.id && interview.status === 'proposed'
              )
              .sort((left, right) => left.slot.localeCompare(right.slot));
            return (
              <article key={application.id} data-coordinator-application-id={application.id} className="rounded border border-indigo-100 bg-indigo-50/40 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">{candidateName(application.candidateId)}</div>
                    <div className="text-xs text-gray-500">{application.id} · {application.status}</div>
                  </div>
                  {application.status === 'screened' && (
                    <button
                      type="button"
                      data-coordinate-interview="propose"
                      onClick={() => void coordinateInterview(application.id, 'propose_slots')}
                      className="ui-button ui-button--primary"
                    >
                      Coordinate slots
                    </button>
                  )}
                </div>
                {result && (
                  <div data-interview-coordinator-result className="space-y-1 text-xs text-indigo-900">
                    <div>stage: {result.stage}</div>
                    {result.nextAction && <div>next: {result.nextAction}</div>}
                    {result.blockers.length > 0 && <div>blockers: {result.blockers.join(' · ')}</div>}
                    {result.bookedInterview && <div>booked: {result.bookedInterview.slot}</div>}
                  </div>
                )}
                {proposed.length > 0 && (
                  <div className="flex flex-wrap gap-1" data-interview-proposals>
                    {proposed.map((interview) => (
                      <button
                        key={interview.id}
                        type="button"
                        data-coordinate-interview="book"
                        onClick={() => void coordinateInterview(application.id, 'book_slot', interview.slot)}
                        className="ui-button ui-button--soft"
                      >
                        Book {new Date(interview.slot).toLocaleString()}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>

      <div data-onboarding-coordinator className="space-y-3">
        <h3 className="font-medium text-gray-800">Onboarding workflow</h3>
        {offers.filter((offer) => offer.status === 'accepted').length === 0 ? (
          <p className="text-xs text-gray-400">No accepted offers.</p>
        ) : (
          offers
            .filter((offer) => offer.status === 'accepted')
            .map((offer) => {
              const tasks = applicationTasks(onboardingTasks, offer);
              const result = onboardingResults[offer.id];
              return (
                <article key={offer.id} data-coordinator-offer-id={offer.id} className="rounded border border-orange-100 bg-orange-50/40 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">Offer {offer.id}</div>
                    {tasks.length === 0 && (
                      <button
                        type="button"
                        data-coordinate-onboarding="initialize"
                        onClick={() => void coordinateOnboarding(offer.id, 'initialize_checklist')}
                        className="ui-button ui-button--warning"
                      >
                        Coordinate checklist
                      </button>
                    )}
                  </div>
                  {result && (
                    <div data-onboarding-coordinator-result className="space-y-1 text-xs text-orange-900">
                      <div>completion: {result.completionPercentage.toFixed(1)}%</div>
                      {result.nextActions.length > 0 && <div>next: {result.nextActions.join(' · ')}</div>}
                      {result.blockers.length > 0 && <div>blockers: {result.blockers.join(' · ')}</div>}
                    </div>
                  )}
                  {tasks.length > 0 && (
                    <div className="space-y-1" data-onboarding-task-controls>
                      {tasks.map((task) => (
                        <div key={task.id} className="flex items-center justify-between gap-2 text-xs">
                          <span>{task.taskName} · {task.status}</span>
                          {task.status === 'pending' && (
                            <button
                              type="button"
                              data-coordinate-onboarding="start-task"
                              onClick={() => void coordinateOnboarding(offer.id, 'update_task', task.id, 'in_progress')}
                              className="ui-button ui-button--soft"
                            >
                              Start
                            </button>
                          )}
                          {task.status === 'in_progress' && (
                            <button
                              type="button"
                              data-coordinate-onboarding="complete-task"
                              onClick={() => void coordinateOnboarding(offer.id, 'update_task', task.id, 'complete')}
                              className="ui-button ui-button--success"
                            >
                              Complete
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })
        )}
      </div>
    </section>
  );
}
