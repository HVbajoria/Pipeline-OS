import { useEffect, useMemo, useState } from 'react';
import {
  ACTIONS,
  EVENTS,
  Joyride,
  STATUS,
  type EventData,
  type Step,
  type TooltipRenderProps
} from 'react-joyride';

/** Stable selectors shared by the shell and the guided tour. */
export const TOUR_TARGETS = {
  brand: '[data-tour="brand"]',
  roleSwitcher: '[data-tour="role-switcher"]',
  roleView: '[data-tour="role-view"]',
  mainWorkflow: '[data-tour="main-workflow"]',
  startTour: '[data-tour="start-tour"]',
  resetDemo: '[data-tour="reset-demo"]',
  documentationNav: '[data-tour="documentation-nav"]',
  documentationRegistry: '[data-tour="documentation-registry"]',
  activityFeed: '[data-tour="activity-feed"]'
} as const;

/**
 * Build the tour from shared-layout targets. The Documentation registry target
 * is included only while that view is mounted, so Joyride never waits on a
 * target that cannot exist in the current role view.
 */
export function getAppTourSteps(includeDocumentation = false): Step[] {
  const steps: Step[] = [
    {
      id: 'brand',
      target: TOUR_TARGETS.brand,
      title: 'One pipeline, one source of truth',
      content:
        'PipelineOS connects requisitions, candidates, interviews, offers, and onboarding through one persisted shared state. Every role and agent sees the same workflow.',
      placement: 'right',
      skipBeacon: true
    },
    {
      id: 'role-switcher',
      target: TOUR_TARGETS.roleSwitcher,
      title: 'Explore each role view',
      content:
        'Use View As to move between the Recruiter, Candidate, Hiring Manager, and Documentation views. Switching roles changes the projection and actor context, not the underlying data.',
      placement: 'right'
    },
    {
      id: 'role-view',
      target: TOUR_TARGETS.roleView,
      title: 'Role-specific workflow controls',
      content:
        'The active view provides the forms and actions for that role. UI actions call the shared OperationClient, so successful changes are persisted before the UI updates.',
      placement: 'top'
    },
    {
      id: 'main-workflow',
      target: TOUR_TARGETS.mainWorkflow,
      title: 'Follow the end-to-end lifecycle',
      content:
        'Start with an open requisition, submit and screen an application, propose and book an interview, collect feedback, send an offer, then complete background checks, benefits, and onboarding.',
      placement: 'top'
    },
    {
      id: 'start-tour',
      target: TOUR_TARGETS.startTour,
      title: 'Reopen this tour anytime',
      content:
        'Close, skip, or finish the tour whenever you like. Start Tour remains available in navigation so you can revisit the workflow after changing roles or state.',
      placement: 'top'
    },
    {
      id: 'reset-demo',
      target: TOUR_TARGETS.resetDemo,
      title: 'Reset the deterministic demo',
      content:
        'Reset DB restores the seeded requisition, eight synthetic candidates, panel, catalogs, and a populated Kanban with linked interview, offer, and onboarding records. It is useful for replaying the video story; repository revisions remain monotonic for synchronizing clients.',
      placement: 'top'
    },
    {
      id: 'documentation-nav',
      target: TOUR_TARGETS.documentationNav,
      title: 'Inspect the WebMCP contract',
      content:
        'Open Documentation to inspect the exact operation names, JSON schemas, output contracts, and read-only annotations used by both the server validator and WebMCP adapter.',
      placement: 'right'
    },
    {
      id: 'activity-feed',
      target: TOUR_TARGETS.activityFeed,
      title: 'Audit every human and agent action',
      content:
        'The Live Activity Feed is persisted Shared_State. It records the operation, actor, original input, exact output or structured error, and timestamp, and updates after state revisions.',
      placement: 'left'
    }
  ];

  if (includeDocumentation) {
    steps.push({
      id: 'documentation-registry',
      target: TOUR_TARGETS.documentationRegistry,
      title: 'The registry is the source of tool documentation',
      content:
        'This view renders all 20 descriptors from the canonical operation registry. The same metadata powers HTTP validation, native modelContext registration, the fallback polyfill, and this documentation.',
      placement: 'top'
    });
  }

  return steps;
}

interface AppTourProps {
  open: boolean;
  includeDocumentation?: boolean;
  onClose: () => void;
}

function TourTooltip({
  backProps,
  closeProps,
  index,
  isLastStep,
  primaryProps,
  size,
  skipProps,
  step,
  tooltipProps
}: TooltipRenderProps) {
  return (
    <section
      {...tooltipProps}
      aria-labelledby="pipelineos-tour-title"
      className="w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-4 text-slate-900 shadow-2xl"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-blue-600">
          PipelineOS tour
        </span>
        <button
          type="button"
          {...closeProps}
          className="rounded p-1 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Close
        </button>
      </div>
      <h2 id="pipelineos-tour-title" className="mb-2 text-base font-semibold">
        {step.title}
      </h2>
      <div className="text-sm leading-6 text-slate-600">{step.content}</div>
      <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3">
        <button
          type="button"
          {...backProps}
          disabled={index === 0}
          className="rounded px-2 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Back
        </button>
        <button
          type="button"
          {...skipProps}
          className="rounded px-2 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Skip
        </button>
        <span
          aria-live="polite"
          className="ml-auto whitespace-nowrap text-xs font-medium text-slate-500"
        >
          Step {index + 1} of {size}
        </span>
        <button
          type="button"
          {...primaryProps}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
        >
          {isLastStep ? 'Finish' : 'Next'}
        </button>
      </div>
    </section>
  );
}

/** A controlled, keyboard-accessible Joyride wrapper for the application shell. */
export function AppTour({
  open,
  includeDocumentation = false,
  onClose
}: AppTourProps) {
  const steps = useMemo(
    () => getAppTourSteps(includeDocumentation),
    [includeDocumentation]
  );
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (open) setStepIndex(0);
  }, [includeDocumentation, open]);

  const finish = () => {
    setStepIndex(0);
    onClose();
  };

  const handleEvent = (event: EventData) => {
    if (event.type === EVENTS.TARGET_NOT_FOUND) {
      // Shared targets should always exist, but skipping a missing optional or
      // asynchronously mounted target is safer than leaving the tour blocked.
      if (event.index >= steps.length - 1) finish();
      else setStepIndex(event.index + 1);
      return;
    }

    if (
      event.status === STATUS.FINISHED ||
      event.status === STATUS.SKIPPED ||
      event.action === ACTIONS.CLOSE ||
      event.action === ACTIONS.SKIP
    ) {
      finish();
      return;
    }

    if (event.type !== EVENTS.STEP_AFTER) return;

    if (event.action === ACTIONS.NEXT) {
      if (event.index >= steps.length - 1) finish();
      else setStepIndex(event.index + 1);
    } else if (event.action === ACTIONS.PREV) {
      setStepIndex(Math.max(0, event.index - 1));
    }
  };

  return (
    <Joyride
      run={open}
      steps={steps}
      stepIndex={stepIndex}
      continuous
      scrollToFirstStep
      onEvent={handleEvent}
      tooltipComponent={TourTooltip}
      locale={{
        back: 'Back',
        close: 'Close',
        last: 'Finish',
        next: 'Next',
        nextWithProgress: 'Next ({current} of {total})',
        skip: 'Skip'
      }}
      options={{
        closeButtonAction: 'close',
        dismissKeyAction: 'close',
        overlayClickAction: false,
        primaryColor: '#2563eb',
        showProgress: true,
        buttons: ['back', 'close', 'primary', 'skip'],
        spotlightPadding: 8,
        targetWaitTimeout: 500,
        textColor: '#0f172a',
        zIndex: 10000
      }}
    />
  );
}
