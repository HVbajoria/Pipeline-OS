import { createElement } from 'react';
// react-dom's runtime export is useful for rendering the real role shell.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import App from '../src/App';
import { actorContextForAgent, actorContextForRole, type AppRole } from '../src/client/actorContext';
import { OperationClient, type FetchLike } from '../src/client/operationClient';
import { SynchronizationController } from '../src/client/synchronization';
import { useStore } from '../src/lib/store';
import { projectActivityFeed, projectKanban } from '../src/lib/viewModels';
import { registerAllTools, resetWebMcpRegistry, WebMcpRuntimeAdapter, type WebMcpRegisteredTool } from '../src/lib/webmcp';
import { PipelineError } from '../src/shared/errors';
import type { ActorContext, SharedStateProjectionWithCatalogs } from '../src/shared/models';
import { OPERATION_NAMES, type OperationName } from '../src/shared/operations';
import { serializeSharedState } from '../src/server/api';
import { defaultOperationHandlers } from '../src/server/operations';
import { OperationService } from '../src/server/operationService';
import { SharedStateRepository } from '../src/server/repository';
import { createSeed } from '../src/server/seed';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function serviceFetch(service: OperationService): FetchLike {
  return async (request, init) => {
    const url = String(request);
    if (url.endsWith('/api/state')) {
      return jsonResponse(serializeSharedState(service.repository.read()));
    }

    const operationName = url.split('/').at(-1) as OperationName;
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown };
    const headers = new Headers(init?.headers);
    const actor: ActorContext = {
      actorType: headers.get('x-actor-type') as ActorContext['actorType'],
      actorId: headers.get('x-actor-id') ?? ''
    };

    try {
      const output = await service.invoke(operationName, body.input as never, actor);
      return jsonResponse(output);
    } catch (error) {
      const pipelineError = PipelineError.from(error);
      return jsonResponse(pipelineError.toPayload(), pipelineError.status);
    }
  };
}

class CapturingAdapter extends WebMcpRuntimeAdapter {
  readonly tools: WebMcpRegisteredTool[] = [];

  override register(tool: WebMcpRegisteredTool): 'development' {
    this.tools.push(tool);
    return 'development';
  }
}

class RevisionEventSource {
  private listener: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    if (type === 'state_changed') this.listener = listener;
  }

  removeEventListener(type: string): void {
    if (type === 'state_changed') this.listener = null;
  }

  close(): void {
    this.closed = true;
  }

  emit(revision: number): void {
    this.listener?.({
      data: JSON.stringify({ type: 'state_changed', revision })
    } as MessageEvent<string>);
  }
}

function domainCollections(projection: SharedStateProjectionWithCatalogs) {
  return {
    jobs: projection.jobs,
    candidates: projection.candidates,
    applications: projection.applications,
    panels: projection.panels,
    interviews: projection.interviews,
    scorecards: projection.scorecards,
    offers: projection.offers,
    onboardingTasks: projection.onboardingTasks,
    backgroundChecks: projection.backgroundChecks,
    benefitsEnrollments: projection.benefitsEnrollments
  };
}

function renderRole(role: AppRole): string {
  useStore.getState().setRole(role);
  // Zustand intentionally supplies its initial snapshot to React SSR. For this
  // integration test, mirror the hydrated store into that snapshot so the
  // real role shell renders the same state a browser subscriber would see.
  const initialState = useStore.getInitialState();
  const initialValues = { ...initialState };
  Object.assign(initialState, useStore.getState());
  try {
    return renderToStaticMarkup(createElement(App));
  } finally {
    Object.assign(initialState, initialValues);
  }
}

async function settleRevisionDrain(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// Feature: pipelineos, Task 7.10: Cross-interface UI integration
// **Validates: Requirements 1.5, 2.4, 3.4, 4.4, 4.5, 7.7, 9.6, 11.6, 12.6, 17.6, 18.8, 19.6, 20.6, 21.8, 22.6, 25.1, 25.2, 25.5**
describe('Task 7.10: cross-interface UI integration', () => {
  it('hydrates every real role view from UI and WebMCP mutations through one snapshot', async () => {
    const service = new OperationService(
      new SharedStateRepository(createSeed()),
      defaultOperationHandlers
    );
    const fetcher = serviceFetch(service);
    let eventSource: RevisionEventSource | undefined;
    const synchronization = new SynchronizationController({
      fetcher,
      eventSourceFactory: () => {
        eventSource = new RevisionEventSource();
        return eventSource;
      }
    });
    const uiClient = new OperationClient({ fetcher });
    let agentRefreshCalls = 0;
    const agentClient = new OperationClient({
      fetcher,
      // Let the SSE controller perform the cross-interface hydration for agent
      // calls. The real default refresh path is covered by uiClient here and by
      // the typed-client transport tests.
      refreshState: async () => {
        agentRefreshCalls += 1;
      }
    });
    const adapter = new CapturingAdapter();
    const recruiter = actorContextForRole('recruiter');
    const candidate = actorContextForRole('candidate');
    const hiringManager = actorContextForRole('hiring-manager');
    const agent = actorContextForAgent('agent-cross-interface');

    resetWebMcpRegistry();
    try {
      await synchronization.start();
      registerAllTools({
        client: agentClient,
        agentContext: agent,
        adapter,
        force: true
      });

      const emitRevision = async () => {
        const revision = service.repository.getRevision();
        eventSource!.emit(revision);
        await settleRevisionDrain();
        expect(useStore.getState().revision).toBe(revision);
      };
      const invokeUi = async (
        name: OperationName,
        input: unknown,
        actor: ActorContext
      ): Promise<unknown> => {
        const output = await uiClient.invoke(name, input as never, actor);
        await emitRevision();
        return output;
      };
      const invokeAgent = async (
        name: OperationName,
        input: unknown
      ): Promise<unknown> => {
        const tool = adapter.tools.find((registeredTool) => registeredTool.name === name);
        expect(tool).toBeDefined();
        const output = await tool!.execute(input);
        await emitRevision();
        return output;
      };

      const uiJob = await invokeUi('create_job_requisition', {
        title: 'UI Platform Engineer',
        department: 'Engineering',
        requirements: ['TypeScript', 'Node.js'],
        compBand: { min: 120000, max: 150000, currency: 'USD' }
      }, recruiter) as { jobId: string };
      const agentJob = await invokeAgent('create_job_requisition', {
        title: 'Agent Reliability Engineer',
        department: 'Platform',
        requirements: ['AWS', 'Reliability'],
        compBand: { min: 130000, max: 160000, currency: 'USD' }
      }) as { jobId: string };
      expect(useStore.getState().jobs.map((job) => job.id)).toEqual(
        expect.arrayContaining([uiJob.jobId, agentJob.jobId, 'job-1'])
      );
      expect(renderRole('recruiter')).toContain('UI Platform Engineer');
      expect(renderRole('candidate')).toContain('Agent Reliability Engineer');

      const application = await invokeAgent('submit_application', {
        candidateId: 'cand-1',
        jobId: 'job-1',
        resumeText: 'Agent-tailored backend resume'
      }) as { applicationId: string; status: 'applied' };
      expect(application.status).toBe('applied');
      expect(useStore.getState().candidates.find((item) => item.id === 'cand-1')?.resumeTextHistory)
        .toEqual(['Agent-tailored backend resume']);
      expect(projectKanban(useStore.getState().applications)
        .find((column) => column.status === 'applied')?.applications)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: application.applicationId, status: 'applied' })
        ]));
      const appliedCandidateView = renderRole('candidate');
      const appliedRecruiterView = renderRole('recruiter');
      expect(appliedCandidateView).toContain('data-application-status="applied"');
      expect(appliedRecruiterView).toContain('data-status="applied"');
      expect(appliedRecruiterView).toContain('Alice Chen');
      expect(appliedCandidateView).toContain('submit_application');

      await invokeUi('screen_candidate', { applicationId: application.applicationId }, recruiter);
      expect(useStore.getState().applications.find((item) => item.id === application.applicationId)?.status)
        .toBe('screened');
      expect(projectKanban(useStore.getState().applications)
        .find((column) => column.status === 'screened')?.applications)
        .toHaveLength(1);

      const proposal = await invokeUi('propose_interview_slots', {
        applicationId: application.applicationId
      }, recruiter) as { proposedSlots: Array<{ interviewId: string; slot: string }> };
      expect(proposal.proposedSlots).toHaveLength(3);
      expect(renderRole('candidate')).toContain('data-interview-status="proposed"');

      const booked = await invokeAgent('book_interview', {
        applicationId: application.applicationId,
        slot: proposal.proposedSlots[0].slot
      }) as { interviewId: string; status: 'booked' };
      expect(booked.status).toBe('booked');
      expect(useStore.getState().applications.find((item) => item.id === application.applicationId)?.status)
        .toBe('interviewing');
      expect(projectKanban(useStore.getState().applications)
        .find((column) => column.status === 'interviewing')?.applications)
        .toHaveLength(1);
      expect(renderRole('candidate')).toContain('data-interview-status="booked"');
      expect(renderRole('recruiter')).toContain('Booked slots:');

      const kit = await invokeUi('get_interview_kit', { jobId: 'job-1' }, hiringManager) as {
        competencies: Array<{ name: string; questions: string[] }>;
      };
      expect(kit.competencies.length).toBeGreaterThanOrEqual(3);
      const competencyScores = Object.fromEntries(
        kit.competencies.map((competency) => [competency.name, 5])
      );
      const feedback = await invokeUi('submit_interview_feedback', {
        interviewId: booked.interviewId,
        interviewer: hiringManager.actorId,
        competencyScores,
        recommendation: 'strong_yes',
        comments: 'Strong systems thinking and clear communication.'
      }, hiringManager) as { scorecardId: string };
      expect(useStore.getState().scorecards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: feedback.scorecardId, interviewId: booked.interviewId })
      ]));
      const hiringManagerView = renderRole('hiring-manager');
      expect(hiringManagerView).toContain('data-interview-completion="completed"');
      expect(hiringManagerView).toContain(`data-scorecard-id="${feedback.scorecardId}"`);
      expect(hiringManagerView).toContain('Strong systems thinking');

      const offer = await invokeUi('generate_offer', {
        applicationId: application.applicationId,
        compAmount: 175000
      }, recruiter) as { offerId: string; status: 'draft' };
      expect(offer.status).toBe('draft');
      expect(renderRole('recruiter')).toContain('Offer: draft');

      await invokeAgent('send_offer', { offerId: offer.offerId });
      const sentCandidateView = renderRole('candidate');
      expect(sentCandidateView).toContain('New offer available for your review.');
      expect(useStore.getState().applications.find((item) => item.id === application.applicationId)?.status)
        .toBe('offer_sent');

      const response = await invokeAgent('respond_to_offer', {
        offerId: offer.offerId,
        decision: 'accept'
      }) as { offerId: string; status: 'accepted' };
      expect(response.status).toBe('accepted');
      expect(useStore.getState().offers.find((item) => item.id === offer.offerId)?.status)
        .toBe('accepted');
      expect(renderRole('candidate')).toContain('data-response-confirmation');
      expect(projectKanban(useStore.getState().applications)
        .find((column) => column.status === 'offer_accepted')?.applications)
        .toHaveLength(1);

      const background = await invokeAgent('initiate_background_check', {
        offerId: offer.offerId
      }) as { backgroundCheckId: string; status: 'pending' | 'clear' };
      expect(background.status).toBe('clear');
      await invokeUi('enroll_benefits', {
        offerId: offer.offerId,
        planSelections: {
          medical: 'medical-plus',
          dental: 'dental-basic',
          vision: 'vision-plus'
        }
      }, candidate);
      const checklist = await invokeUi('generate_onboarding_checklist', {
        offerId: offer.offerId
      }, recruiter) as { tasks: Array<{ taskId: string; taskName: string; dueDate: string }> };
      expect(checklist.tasks.length).toBeGreaterThanOrEqual(2);
      const status = await invokeAgent('get_onboarding_status', {
        offerId: offer.offerId
      }) as {
        backgroundCheckStatus: 'pending' | 'clear' | 'flagged' | null;
        benefitsEnrolled: boolean;
        taskCompletion: { done: number; total: number };
        completionPercentage: number;
      };
      expect(status).toMatchObject({
        backgroundCheckStatus: 'clear',
        benefitsEnrolled: true,
        taskCompletion: { done: 0, total: checklist.tasks.length },
        completionPercentage: 0
      });

      const finalState = useStore.getState();
      expect(finalState.revision).toBe(service.repository.getRevision());
      expect(finalState.applications.find((item) => item.id === application.applicationId)?.status)
        .toBe('onboarding');
      expect(projectKanban(finalState.applications)
        .find((column) => column.status === 'onboarding')?.applications)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: application.applicationId, status: 'onboarding' })
        ]));
      expect(finalState.activityLog.length).toBeGreaterThanOrEqual(15);
      expect(projectActivityFeed(finalState.activityLog)[0].operation).toBe('get_onboarding_status');
      expect(agentRefreshCalls).toBeGreaterThan(0);

      const recruiterView = renderRole('recruiter');
      const candidateView = renderRole('candidate');
      const finalHiringManagerView = renderRole('hiring-manager');
      const documentationView = renderRole('documentation');
      for (const view of [recruiterView, candidateView, finalHiringManagerView, documentationView]) {
        expect(view).toContain('Live Activity Feed');
        expect(view).toContain('get_onboarding_status');
      }
      expect(recruiterView).toContain('Provision engineering accounts');
      expect(recruiterView).toContain('Background check:');
      expect(candidateView).toContain('Enrollment recorded: medical-plus');
      expect(candidateView).toContain('Background: clear · Benefits: enrolled');
      expect(candidateView).toContain('0/3 complete (0%)');
      expect(finalHiringManagerView).toContain(`data-scorecard-id="${feedback.scorecardId}"`);
      for (const operationName of OPERATION_NAMES) {
        expect(documentationView).toContain(operationName);
      }
    } finally {
      synchronization.stop();
      resetWebMcpRegistry();
      useStore.getState().setRole('recruiter');
    }
  });

  it('renders read-only WebMCP results through the shared feed without changing domain collections', async () => {
    const service = new OperationService(
      new SharedStateRepository(createSeed()),
      defaultOperationHandlers
    );
    const fetcher = serviceFetch(service);
    let eventSource: RevisionEventSource | undefined;
    const synchronization = new SynchronizationController({
      fetcher,
      eventSourceFactory: () => {
        eventSource = new RevisionEventSource();
        return eventSource;
      }
    });
    let agentRefreshCalls = 0;
    const agentClient = new OperationClient({
      fetcher,
      refreshState: async () => {
        agentRefreshCalls += 1;
      }
    });
    const adapter = new CapturingAdapter();
    resetWebMcpRegistry();

    try {
      await synchronization.start();
      registerAllTools({
        client: agentClient,
        agentContext: actorContextForAgent('agent-read-only'),
        adapter,
        force: true
      });

      const invokeRead = async (name: OperationName, input: unknown): Promise<unknown> => {
        const before = domainCollections(serializeSharedState(service.repository.read()));
        const tool = adapter.tools.find((registeredTool) => registeredTool.name === name);
        expect(tool).toBeDefined();
        const output = await tool!.execute(input);
        eventSource!.emit(service.repository.getRevision());
        await settleRevisionDrain();
        const after = domainCollections(serializeSharedState(service.repository.read()));
        expect(after).toEqual(before);
        return output;
      };

      const search = await invokeRead('search_candidates', { query: 'backend' }) as {
        results: Array<{ candidateId: string; name: string }>;
      };
      expect(search.results.some((result) => result.candidateId === 'cand-1')).toBe(true);
      expect(renderRole('recruiter')).toContain('search_candidates');

      const faq = await invokeRead('answer_candidate_faq', {
        jobId: 'job-1',
        question: 'What is the compensation range?'
      }) as { answer: string; answeredFromData: boolean };
      expect(faq.answeredFromData).toBe(true);
      expect(faq.answer).toContain('160000');
      expect(renderRole('candidate')).toContain('answeredFromData');
      expect(renderRole('candidate')).toContain('160000');

      const availability = await invokeRead('check_interviewer_availability', {
        panelId: 'panel-1',
        dateRange: {
          start: '2026-09-01T00:00:00Z',
          end: '2026-09-04T00:00:00Z'
        }
      }) as { commonFreeSlots: string[] };
      expect(availability.commonFreeSlots.length).toBeGreaterThan(0);
      expect(renderRole('recruiter')).toContain('commonFreeSlots');

      const kit = await invokeRead('get_interview_kit', { jobId: 'job-1' }) as {
        competencies: Array<{ name: string; questions: string[] }>;
      };
      expect(kit.competencies.length).toBeGreaterThanOrEqual(3);
      expect(renderRole('hiring-manager')).toContain('System Design');
      expect(renderRole('documentation')).toContain('get_interview_kit');
      expect(agentRefreshCalls).toBe(4);
      expect(useStore.getState().activityLog.slice(-4).map((entry) => entry.toolName)).toEqual([
        'search_candidates',
        'answer_candidate_faq',
        'check_interviewer_availability',
        'get_interview_kit'
      ]);
    } finally {
      synchronization.stop();
      resetWebMcpRegistry();
      useStore.getState().setRole('recruiter');
    }
  });
});
