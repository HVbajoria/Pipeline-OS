import { describe, expect, it } from 'vitest';
import { getAppTourSteps, TOUR_TARGETS } from '../src/components/AppTour';

describe('application tour configuration', () => {
  it('uses stable shared-layout targets and skips the optional registry by default', () => {
    const steps = getAppTourSteps();

    expect(steps.map((step) => step.id)).toEqual([
      'brand',
      'role-switcher',
      'role-view',
      'main-workflow',
      'start-tour',
      'reset-demo',
      'documentation-nav',
      'activity-feed'
    ]);
    expect(steps.map((step) => step.target)).toEqual([
      TOUR_TARGETS.brand,
      TOUR_TARGETS.roleSwitcher,
      TOUR_TARGETS.roleView,
      TOUR_TARGETS.mainWorkflow,
      TOUR_TARGETS.startTour,
      TOUR_TARGETS.resetDemo,
      TOUR_TARGETS.documentationNav,
      TOUR_TARGETS.activityFeed
    ]);
    expect(steps.some((step) => step.id === 'documentation-registry')).toBe(false);
  });

  it('adds the registry spotlight only for the mounted Documentation view', () => {
    const steps = getAppTourSteps(true);
    const registryStep = steps.at(-1);

    expect(registryStep).toMatchObject({
      id: 'documentation-registry',
      target: TOUR_TARGETS.documentationRegistry,
      title: 'The registry is the source of tool documentation'
    });
    expect(String(registryStep?.content)).toContain('19 descriptors');
  });
});
