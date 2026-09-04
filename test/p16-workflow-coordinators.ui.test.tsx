import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import WorkflowCoordinatorPanel from '../src/components/WorkflowCoordinatorPanel';
import { useStore } from '../src/lib/store';
import { serializeSharedState } from '../src/server/api';
import { SharedStateRepository } from '../src/server/repository';
import { createSeed } from '../src/server/seed';
import type { ActorContext } from '../src/shared/models';
import { TEST_TIMESTAMP } from './factories';

const RECRUITER: ActorContext = {
  actorType: 'human_ui',
  actorId: 'sarah-recruiter'
};

function renderWithStore(): string {
  const initialState = useStore.getInitialState();
  const initialValues = { ...initialState };
  Object.assign(initialState, useStore.getState());
  try {
    return renderToStaticMarkup(
      createElement(WorkflowCoordinatorPanel, {
        actor: RECRUITER,
        role: 'recruiter'
      })
    );
  } finally {
    Object.assign(initialState, initialValues);
  }
}

afterEach(() => {
  useStore.getState().hydrate(
    serializeSharedState(new SharedStateRepository(createSeed()).read())
  );
  useStore.getState().setRole('recruiter');
});

describe('P16 workflow coordinator UI projection', () => {
  it('renders proposal, booking, checklist, and task-transition controls from shared state', () => {
    const seed = createSeed();
    seed.applications = new Map([
      [
        'p16-ui-application',
        {
          id: 'p16-ui-application',
          candidateId: 'cand-1',
          jobId: 'job-1',
          status: 'screened',
          screeningScore: null,
          screeningRationale: null,
          notes: [],
          createdAt: TEST_TIMESTAMP
        }
      ]
    ]);
    seed.interviews = new Map([
      [
        'p16-ui-interview',
        {
          id: 'p16-ui-interview',
          applicationId: 'p16-ui-application',
          panelId: 'panel-1',
          slot: '2026-09-01T10:00:00Z',
          status: 'proposed'
        }
      ]
    ]);
    seed.offers = new Map([
      [
        'p16-ui-offer',
        {
          id: 'p16-ui-offer',
          applicationId: 'p16-ui-application',
          compAmount: 175000,
          currency: 'USD',
          status: 'accepted',
          counterAmount: null,
          sentAt: TEST_TIMESTAMP,
          respondedAt: TEST_TIMESTAMP
        }
      ]
    ]);
    seed.onboardingTasks = new Map([
      [
        'p16-ui-task-pending',
        {
          id: 'p16-ui-task-pending',
          offerId: 'p16-ui-offer',
          taskName: 'Provision engineering accounts',
          status: 'pending',
          dueDate: '2026-09-07T09:00:00.000Z'
        }
      ],
      [
        'p16-ui-task-progress',
        {
          id: 'p16-ui-task-progress',
          offerId: 'p16-ui-offer',
          taskName: 'Review company policies',
          status: 'in_progress',
          dueDate: '2026-09-10T09:00:00.000Z'
        }
      ]
    ]);

    useStore.getState().hydrate(
      serializeSharedState(new SharedStateRepository(seed).read())
    );
    const markup = renderWithStore();

    expect(markup).toContain('aria-label="Workflow coordinators"');
    expect(markup).toContain('data-workflow-role="recruiter"');
    expect(markup).toContain('Ananya Sharma');
    expect(markup).toContain('data-coordinate-interview="propose"');
    expect(markup).toContain('Coordinate slots');
    expect(markup).toContain('data-coordinate-interview="book"');
    expect(markup).toContain('data-coordinate-onboarding="start-task"');
    expect(markup).toContain('data-coordinate-onboarding="complete-task"');
    expect(markup).not.toContain('No screened or interviewing applications.');
    expect(markup).not.toContain('No accepted offers.');
  });
});
