import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Activity, Book, Briefcase, CheckCircle, FileText, HelpCircle, Menu, User, Users, X } from 'lucide-react';
import ActivityTracePanel from './components/ActivityTracePanel';
import { AppTour } from './components/AppTour';
import ApprovalCardsPanel from './components/ApprovalCardsPanel';
import CandidateComparisonPanel from './components/CandidateComparisonPanel';
import LivePublicJobsPanel from './components/LivePublicJobsPanel';
import WorkflowCoordinatorPanel from './components/WorkflowCoordinatorPanel';
import WorkflowStatusPanel from './components/WorkflowStatusPanel';
import GitHubProspectsPanel from './components/GitHubProspectsPanel';
import { useStore } from './lib/store';
import { projectActivityFeed, projectKanban } from './lib/viewModels';
import { actorContextForRole } from './client/actorContext';
import { operationClient } from './client/operationClient';
import { PipelineError } from './shared/errors';
import { calculateOnboardingStatus } from './shared/domain/onboarding';
import type {
  CheckInterviewerAvailabilityOutput,
  DiscoverCapabilitiesOutput,
  GetCandidateProfileOutput,
  GetInterviewKitOutput,
  GetOnboardingStatusOutput,
  GetPanelFeedbackSummaryOutput,
  ProposeInterviewSlotsOutput
} from './shared/operations';
import type { ApplicationRecord, PlanSelections } from './shared/models';
import { OPERATION_NAMES, OPERATION_REGISTRY } from './shared/operations';

function errorMessage(error: unknown): string {
  return PipelineError.from(error).message;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function useOperationError(): [string | null, (error: unknown) => void] {
  const [message, setMessage] = useState<string | null>(null);
  return [message, (error) => setMessage(errorMessage(error))];
}

const MAX_VISIBLE_ACTIVITY_ENTRIES = 100;

interface LiveActivityFeedProps {
  open: boolean;
  onClose: () => void;
}

const LiveActivityFeed = ({ open, onClose }: LiveActivityFeedProps) => {
  const activityLog = useStore((state) => state.activityLog);
  const entries = projectActivityFeed(activityLog).slice(0, MAX_VISIBLE_ACTIVITY_ENTRIES);

  return (
    <aside
      aria-label="Live Activity Feed"
      data-tour="activity-feed"
      className={`activity-feed tour-agent-log${open ? ' is-open' : ''}`}
    >
      <header className="activity-feed__header">
        <span className="activity-feed__icon" aria-hidden="true"><Activity className="h-4 w-4" /></span>
        <span className="activity-feed__header-copy">
          <span className="activity-feed__title">Live Activity Feed</span>
          <span className="activity-feed__subtitle">Persisted operations and audit trace</span>
        </span>
        <button type="button" className="activity-feed__close" onClick={onClose} aria-label="Close activity feed">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="activity-feed__body">
        {entries.map((entry) => (
          <article
            key={entry.id}
            data-activity-id={entry.id}
            data-trace-group-id={entry.traceGroupId}
            className="activity-entry"
          >
            <div className="activity-entry__topline">
              <span className="activity-entry__operation">{entry.operation}</span>
              <span className={`activity-entry__result ${entry.error ? 'activity-entry__result--error' : 'activity-entry__result--success'}`}>
                {entry.error ? entry.error.code : 'success'}
              </span>
            </div>
            {(entry.phase || entry.approvalId || entry.replayed || entry.originalActivityId || entry.stale || entry.correlationId || entry.traceId || (entry.redactions && entry.redactions.length > 0)) && (
              <div data-activity-markers className="activity-markers">
                {entry.phase && <span className="activity-marker">phase: {entry.phase}</span>}
                {entry.approvalId && <span className="activity-marker activity-marker--accent">approval: {entry.approvalId}</span>}
                {entry.replayed && <span className="activity-marker activity-marker--accent">replayed</span>}
                {entry.originalActivityId && <span className="activity-marker activity-marker--accent">original: {entry.originalActivityId}</span>}
                {entry.stale && <span className="activity-marker activity-marker--warning">stale</span>}
                {entry.correlationId && <span className="activity-marker activity-marker--info">correlation: {entry.correlationId}</span>}
                {entry.traceId && <span className="activity-marker activity-marker--info">trace: {entry.traceId}</span>}
                {entry.redactions && entry.redactions.length > 0 && <span className="activity-marker activity-marker--warning">redacted: {entry.redactions.length}</span>}
              </div>
            )}
            <dl className="activity-entry__meta">
              <div><dt>actor</dt><dd className="inline"> {entry.actorType} · {entry.actorId}</dd></div>
              <div><dt>timestamp</dt><dd className="inline"> {entry.timestamp}</dd></div>
              {entry.spanId && <div><dt>root span</dt><dd className="inline"> {entry.spanId}</dd></div>}
            </dl>
            <div className="activity-entry__payloads">
              <details className="activity-entry__payload">
                <summary>View input</summary>
                <pre>{json(entry.input)}</pre>
              </details>
              <details className="activity-entry__payload">
                <summary>{entry.error ? 'View error' : 'View output'}</summary>
                <pre>{json(entry.error ?? entry.output)}</pre>
              </details>
            </div>
            <ActivityTracePanel entry={entry} />
          </article>
        ))}
        {entries.length === 0 && (
          <div className="activity-feed__empty">No activity yet.</div>
        )}
        {activityLog.length > MAX_VISIBLE_ACTIVITY_ENTRIES && (
          <div className="activity-feed__empty">Showing the latest {MAX_VISIBLE_ACTIVITY_ENTRIES} activities.</div>
        )}
      </div>
    </aside>
  );
};

interface NavigationProps {
  onStartTour: () => void;
  mobileOpen: boolean;
  onClose: () => void;
}

const Navigation = ({ onStartTour, mobileOpen, onClose }: NavigationProps) => {
  const { currentRole, setRole, resetState } = useStore();
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const reset = async () => {
    try {
      setResetError(null);
      setResetting(true);
      await resetState();
    } catch (error) {
      setResetError(errorMessage(error));
    } finally {
      setResetting(false);
    }
  };

  const roles = [
    ['recruiter', Users, 'Recruiter'],
    ['candidate', User, 'Candidate'],
    ['hiring-manager', FileText, 'Hiring Manager'],
    ['documentation', Book, 'Documentation']
  ] as const;

  return (
    <nav aria-label="Primary navigation" className={`app-nav${mobileOpen ? ' is-open' : ''}`}>
      <div data-tour="brand" className="app-nav__brand">
        <span className="app-nav__brand-mark" aria-hidden="true"><Briefcase className="h-4 w-4" /></span>
        <span className="app-nav__brand-copy">
          <span className="app-nav__brand-name">PipelineOS</span>
          <span className="app-nav__brand-caption">Recruiting operations</span>
        </span>
        <button type="button" className="app-nav__close" onClick={onClose} aria-label="Close navigation">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div data-tour="role-switcher" className="app-nav__workspace tour-role-switcher">
        <p className="app-nav__eyebrow">Workspace</p>
        <div className="app-nav__items">
          {roles.map(([role, Icon, label]) => (
            <button
              type="button"
              key={role}
              onClick={() => { setRole(role); onClose(); }}
              data-tour={role === 'documentation' ? 'documentation-nav' : undefined}
              aria-current={currentRole === role ? 'page' : undefined}
              className="app-nav__item"
            >
              <Icon className="h-4 w-4" /> <span>{label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="app-nav__footer">
        <p className="app-nav__footer-label">Demo controls</p>
        <button type="button" onClick={onStartTour} data-tour="start-tour" className="app-nav__utility">
          <HelpCircle className="h-4 w-4" /> Start Tour
        </button>
        <button type="button" onClick={() => void reset()} disabled={resetting} data-tour="reset-demo" className="app-nav__utility">
          <Activity className="h-4 w-4" /> {resetting ? 'Resetting demo…' : 'Reset demo state'}
        </button>
        {resetError && <p className="app-nav__error" role="alert">{resetError}</p>}
      </div>
    </nav>
  );
};

const DocumentationView = () => {
  const descriptors = OPERATION_NAMES.map((name) => OPERATION_REGISTRY[name]);
  const [manifest, setManifest] = useState<DiscoverCapabilitiesOutput | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const recruiterActor = actorContextForRole('recruiter');

  useEffect(() => {
    let active = true;
    void operationClient.discoverCapabilities(recruiterActor)
      .then((nextManifest) => {
        if (active) setManifest(nextManifest);
      })
      .catch((error: unknown) => {
        if (active) setManifestError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div data-tour="role-view" className="page-shell">
      <header className="page-header">
        <div className="page-header__copy">
          <p className="page-header__eyebrow">Platform reference</p>
          <h1 className="page-title">WebMCP tools documentation</h1>
          <p className="page-description">
            The documentation is rendered from the same {OPERATION_NAMES.length} descriptors registered with WebMCP. Each actor-scoped manifest entry exposes safe execution mode, approval policy, resource-scope summary, and redacted-field metadata; capability visibility is informational and denied calls still return the canonical structured service error.
          </p>
        </div>
        <div className="page-header__meta">
          <span className="status-pill status-pill--info">{OPERATION_NAMES.length} registered operations</span>
          <span className="status-pill status-pill--neutral">Read-only reference</span>
        </div>
      </header>
        {manifest && (
          <p data-capability-manifest className="mt-2 text-xs text-gray-500">
            Manifest {manifest.manifestVersion} · policy {manifest.policyVersion} · {manifest.capabilities.filter((entry) => entry.allowed).length}/{manifest.capabilities.length} allowed for {manifest.actor.actorId}
          </p>
        )}
        {manifestError && <p data-capability-manifest-error className="mt-2 text-xs text-amber-700">Capability manifest unavailable: {manifestError}</p>}
      <div data-tour="documentation-registry" className="space-y-6">
        {descriptors.map((tool) => {
          const capability = manifest?.capabilities.find((entry) => entry.name === tool.name);
          return (
            <article key={tool.name} className="panel panel--padded">
              <div className="flex items-center justify-between gap-3 mb-2">
                <h2 className="text-lg font-bold text-gray-900 font-mono text-blue-600">{tool.name}</h2>
                <span className="text-xs rounded-full px-2 py-1 bg-slate-100 text-slate-600">{tool.readOnly ? 'read-only' : 'mutation'}</span>
              </div>
              <p className="text-gray-700 mb-2">{tool.description}</p>
              <p data-operation-capability className="mb-2 text-xs text-gray-500">
                capability <code>{tool.requiredCapability}</code> · mode <code>{tool.executionClass}</code> · approval <code>{tool.approvalPolicy}</code> · {tool.planable ? 'planable' : 'direct'}
                {capability && ` · ${capability.allowed ? 'allowed' : `denied: ${capability.denialReason ?? 'capability_denied'}`}`}
              </p>
              {capability && (
                <p data-capability-metadata className="mb-4 text-xs text-gray-500">
                  scope <code>{capability.resourceScope}</code> · redactions <code>{capability.redactedFields.join(', ')}</code>
                </p>
              )}
              <pre className="bg-slate-50 p-4 rounded-lg border border-slate-200 overflow-x-auto text-sm text-slate-800 font-mono whitespace-pre-wrap">
                {json({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations })}
              </pre>
            </article>
          );
        })}
      </div>
    </div>
  );
};

const FeedbackSummaryPanel = ({ summary }: { summary: GetPanelFeedbackSummaryOutput }) => (
  <div className="mt-2 rounded bg-indigo-50 border border-indigo-100 p-2 text-xs space-y-1">
    <div className="flex justify-between gap-2 font-medium text-indigo-900">
      <span>Panel feedback</span>
      <span>{summary.scorecards.length} scorecard{summary.scorecards.length === 1 ? '' : 's'}</span>
    </div>
    {Object.keys(summary.averageScores).length > 0 && (
      <p className="text-indigo-800">
        Averages: {Object.entries(summary.averageScores).map(([competency, score]) => `${competency} ${score.toFixed(1)}`).join(' · ')}
      </p>
    )}
    {Object.keys(summary.recommendationTally).length > 0 && (
      <p className="text-indigo-800">
        Recommendations: {Object.entries(summary.recommendationTally).map(([recommendation, count]) => `${recommendation} ${count}`).join(' · ')}
      </p>
    )}
  </div>
);

const RecruiterView = () => {
  const { jobs, applications, candidates, interviews, offers, onboardingTasks, backgroundChecks, benefitsEnrollments, panels, catalogs } = useStore();
  const [profile, setProfile] = useState<GetCandidateProfileOutput | null>(null);
  const profileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const [feedbackSummaries, setFeedbackSummaries] = useState<Record<string, GetPanelFeedbackSummaryOutput>>({});
  const [commonSlotsByApplication, setCommonSlotsByApplication] = useState<Record<string, CheckInterviewerAvailabilityOutput['commonFreeSlots']>>({});
  const [proposedSlotsByApplication, setProposedSlotsByApplication] = useState<Record<string, ProposeInterviewSlotsOutput['proposedSlots']>>({});
  const [schedulingAppId, setSchedulingAppId] = useState<string | null>(null);
  const [offerAmounts, setOfferAmounts] = useState<Record<string, string>>({});
  const [onboardingStatus, setOnboardingStatus] = useState<Record<string, GetOnboardingStatusOutput>>({});
  const [error, setError] = useOperationError();
  const actor = actorContextForRole('recruiter');

  useEffect(() => {
    if (!profile) return undefined;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    profileCloseButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfile(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [profile]);

  const run = async (operation: () => Promise<unknown>) => {
    try {
      setError(null);
      return await operation();
    } catch (caught) {
      setError(caught);
      return undefined;
    }
  };

  const handleCreateReq = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const requirements = String(data.get('requirements') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    const result = await run(() => operationClient.invoke('create_job_requisition', {
      title: String(data.get('title') ?? ''),
      department: String(data.get('department') ?? ''),
      requirements,
      compBand: {
        min: Number(data.get('min')),
        max: Number(data.get('max')),
        currency: String(data.get('currency') ?? '')
      }
    }, actor));
    if (result) form.reset();
  };

  const loadFeedbackSummary = async (applicationId: string) => {
    const result = await run(() => operationClient.invoke('get_panel_feedback_summary', { applicationId }, actor));
    if (result) {
      setFeedbackSummaries((previous) => ({
        ...previous,
        [applicationId]: result as GetPanelFeedbackSummaryOutput
      }));
    }
  };

  const handleProfile = async (candidateId: string) => {
    const result = await run(() => operationClient.invoke('get_candidate_profile', { candidateId }, actor));
    if (!result) return;
    const candidateProfile = result as GetCandidateProfileOutput;
    setProfile(candidateProfile);
    setFeedbackSummaries({});
    for (const application of candidateProfile.applicationHistory) {
      const summary = await run(() => operationClient.invoke('get_panel_feedback_summary', { applicationId: application.id }, actor));
      if (!summary) break;
      setFeedbackSummaries((previous) => ({
        ...previous,
        [application.id]: summary as GetPanelFeedbackSummaryOutput
      }));
    }
  };

  const handleScreen = (applicationId: string) => run(() => operationClient.invoke('screen_candidate', { applicationId }, actor));

  const handlePropose = async (application: ApplicationRecord) => {
    const panel = panels.find((candidatePanel) => candidatePanel.jobId === application.jobId);
    if (!panel) {
      setError(new Error('No interview panel is configured for this application'));
      return;
    }
    const slots = catalogs.availabilityCalendar.flatMap((entry) => entry.freeSlots).sort();
    const start = slots[0] ?? '2026-09-01T00:00:00Z';
    const last = slots.at(-1) ?? '2026-09-10T00:00:00Z';
    const end = new Date(new Date(last).getTime() + 60 * 60 * 1000).toISOString();
    const common = await run(() => operationClient.invoke('check_interviewer_availability', {
      panelId: panel.id,
      dateRange: { start, end }
    }, actor));
    if (!common) return;
    const commonOutput = common as CheckInterviewerAvailabilityOutput;
    setCommonSlotsByApplication((previous) => ({
      ...previous,
      [application.id]: commonOutput.commonFreeSlots
    }));
    const proposed = await run(() => operationClient.invoke('propose_interview_slots', { applicationId: application.id }, actor));
    if (!proposed) return;
    const proposedOutput = proposed as ProposeInterviewSlotsOutput;
    setProposedSlotsByApplication((previous) => ({
      ...previous,
      [application.id]: proposedOutput.proposedSlots
    }));
    setSchedulingAppId(application.id);
  };

  const handleBook = async (applicationId: string, slot: string) => {
    const result = await run(() => operationClient.invoke('book_interview', { applicationId, slot }, actor));
    if (result) setSchedulingAppId(null);
  };
  const handleOffer = (applicationId: string, amount: string) => run(() => operationClient.invoke('generate_offer', { applicationId, compAmount: Number(amount) }, actor));
  const handleSendOffer = (offerId: string) => run(() => operationClient.invoke('send_offer', { offerId }, actor));
  const handleBackgroundCheck = (offerId: string) => run(() => operationClient.invoke('initiate_background_check', { offerId }, actor));
  const handleChecklist = (offerId: string) => run(() => operationClient.invoke('generate_onboarding_checklist', { offerId }, actor));
  const handleOnboardingStatus = async (offerId: string) => {
    const result = await run(() => operationClient.invoke('get_onboarding_status', { offerId }, actor));
    if (result) setOnboardingStatus((previous) => ({ ...previous, [offerId]: result as GetOnboardingStatusOutput }));
  };

  const columns = useMemo(() => projectKanban(applications), [applications]);

  return (
    <div data-tour="role-view" className="page-shell page-shell--wide">
      <header className="page-header">
        <div className="page-header__copy">
          <p className="page-header__eyebrow">Recruiting operations</p>
          <h1 className="page-title">Recruiter dashboard</h1>
          <p className="page-description">A live command center for requisitions, candidate decisions, interviews, offers, and onboarding. Every card is projected from the persisted shared state.</p>
        </div>
        <div className="page-header__meta">
          <span className="status-pill status-pill--success"><span aria-hidden="true">●</span> Shared state connected</span>
          <span className="status-pill status-pill--neutral">{applications.length} active applications</span>
        </div>
      </header>
      {error && <div role="alert" className="callout callout--danger mb-5">{error}</div>}
      <LivePublicJobsPanel />
      <ApprovalCardsPanel actor={actor} role="recruiter" />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 page-section">
        <WorkflowStatusPanel actor={actor} role="recruiter" />
        <CandidateComparisonPanel actor={actor} role="recruiter" />
      </div>
      <WorkflowCoordinatorPanel actor={actor} role="recruiter" />

      {profile && (
        <div role="dialog" aria-modal="true" aria-labelledby="recruiter-profile-title" className="modal-backdrop fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="modal-panel bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto shadow-2xl p-6">
            <div className="flex justify-between items-start mb-5">
              <div><h2 id="recruiter-profile-title" className="text-xl font-bold">{profile.name}</h2><p className="text-sm text-gray-500">{profile.email}</p></div>
              <button ref={profileCloseButtonRef} type="button" className="icon-button" onClick={() => setProfile(null)} aria-label="Close profile"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm mb-4">Skills: {profile.skills.join(', ')}</p>
            <pre className="text-sm bg-gray-50 rounded p-3 whitespace-pre-wrap">{profile.resumeText}</pre>
            <h3 className="font-semibold mt-5 mb-2">Application history</h3>
            {profile.applicationHistory.length === 0 ? <p className="text-sm text-gray-500">No applications found.</p> : <ul className="space-y-2">{profile.applicationHistory.map((application) => <li key={application.id} className="border rounded p-2 text-sm"><div className="flex justify-between gap-2"><span>{application.jobId}</span><span>{application.status}</span></div>{feedbackSummaries[application.id] && <FeedbackSummaryPanel summary={feedbackSummaries[application.id]} />}</li>)}</ul>}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 page-section">
        <form onSubmit={handleCreateReq} className="panel panel--padded space-y-4">
          <h2 className="panel__title">New requisition</h2>
          <input name="title" placeholder="Job title" required className="w-full border rounded p-2 text-sm" />
          <input name="department" placeholder="Department" required className="w-full border rounded p-2 text-sm" />
          <input name="requirements" placeholder="Requirements (comma separated)" required className="w-full border rounded p-2 text-sm" />
          <div className="flex gap-2"><input name="min" type="number" placeholder="Min" required className="w-full border rounded p-2 text-sm" /><input name="max" type="number" placeholder="Max" required className="w-full border rounded p-2 text-sm" /><input name="currency" defaultValue="USD" required className="w-24 border rounded p-2 text-sm" /></div>
          <button type="submit" className="ui-button ui-button--primary w-full">Create requisition</button>
        </form>
        <GitHubProspectsPanel actor={actor} role="recruiter" />
      </div>

      <section className="page-section">
        <div className="section-heading"><div><h2 className="section-heading__title">Requisitions</h2><p className="section-heading__description">Internal roles and their current application volume.</p></div></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{jobs.map((job) => <div key={job.id} className="panel panel--padded"><div className="flex justify-between"><h3 className="font-semibold">{job.title}</h3><span className="text-xs text-green-700">{job.status}</span></div><p className="text-sm text-gray-500">{job.department} · {job.compBand.min.toLocaleString()}–{job.compBand.max.toLocaleString()} {job.compBand.currency}</p><p className="text-sm text-gray-600 mt-2">{applications.filter((application) => application.jobId === job.id).length} applications</p></div>)}</div>
      </section>

      <section className="page-section">
        <div className="section-heading"><div><h2 className="section-heading__title">Pipeline Kanban</h2><p className="section-heading__description">Columns follow persisted application status.</p></div></div>
        <div className="kanban-grid">
          {columns.map((column) => (
            <div key={column.status} data-status={column.status} className="kanban-column">
              <h3 className="capitalize font-semibold text-sm mb-3">{column.label} <span className="text-gray-400">({column.applications.length})</span></h3>
              <div className="space-y-3">
                {column.applications.map((application) => {
                  const candidate = candidates.find((item) => item.id === application.candidateId);
                  const job = jobs.find((item) => item.id === application.jobId);
                  const offer = offers.find((item) => item.applicationId === application.id);
                  const appInterviews = interviews.filter((item) => item.applicationId === application.id);
                  const bookedInterviews = appInterviews.filter((interview) => interview.status === 'booked');
                  const persistedProposedSlots = appInterviews
                    .filter((interview) => interview.status === 'proposed')
                    .map((interview) => ({ interviewId: interview.id, slot: interview.slot }));
                  const proposedSlots = persistedProposedSlots.length > 0
                    ? persistedProposedSlots
                    : (proposedSlotsByApplication[application.id] ?? []);
                  const acceptedOffer = offer?.status === 'accepted' ? offer : undefined;
                  const tasks = acceptedOffer ? onboardingTasks.filter((task) => task.offerId === acceptedOffer.id) : [];
                  const background = acceptedOffer ? backgroundChecks.find((check) => check.offerId === acceptedOffer.id) : undefined;
                  const benefits = acceptedOffer ? benefitsEnrollments.find((enrollment) => enrollment.offerId === acceptedOffer.id) : undefined;
                  const status = acceptedOffer ? onboardingStatus[acceptedOffer.id] : undefined;
                  const feedbackSummary = feedbackSummaries[application.id];
                  const commonSlots = commonSlotsByApplication[application.id] ?? [];
                  const defaultOfferAmount = job ? String(Math.round((job.compBand.min + job.compBand.max) / 2)) : '';
                  const offerAmount = offerAmounts[application.id] ?? defaultOfferAmount;
                  return (
                    <article key={application.id} className="kanban-card">
                      <div className="flex justify-between gap-2"><strong>{candidate?.name ?? application.candidateId}</strong><span className="text-xs text-gray-500">{application.status}</span></div>
                      {application.screeningScore !== null && <div className="text-xs text-gray-600 mt-1"><p>Screening: {application.screeningScore}%</p>{application.screeningRationale && <p className="text-gray-500">{application.screeningRationale}</p>}</div>}
                      {offer && <div className="text-xs mt-1"><p>Offer: {offer.status} · {offer.compAmount.toLocaleString()} {offer.currency}</p>{offer.compensationWarning && <p className="text-amber-700">Compensation warning: {offer.compensationWarning}</p>}</div>}
                      {bookedInterviews.length > 0 && <p className="text-xs mt-1 text-green-700">Booked slots: {bookedInterviews.map((interview) => new Date(interview.slot).toLocaleString()).join(' · ')}</p>}
                      {appInterviews.some((interview) => interview.status === 'completed') && <p className="text-xs mt-1 text-indigo-700">Interview feedback submitted</p>}
                      {feedbackSummary && <FeedbackSummaryPanel summary={feedbackSummary} />}
                      {acceptedOffer && <div className="mt-2 rounded bg-orange-50 border border-orange-100 p-2 text-xs"><p>Background check: <strong>{background?.status ?? 'not started'}</strong> · Benefits: <strong>{status ? (status.benefitsEnrolled ? 'enrolled' : 'not enrolled') : (benefits ? 'enrolled' : 'not enrolled')}</strong></p><p>Tasks: <strong>{status ? `${status.taskCompletion.done}/${status.taskCompletion.total} complete (${status.completionPercentage}%)` : `${tasks.filter((task) => task.status === 'complete').length}/${tasks.length} complete`}</strong></p>{tasks.length > 0 && <ul className="mt-1 space-y-1">{tasks.map((task) => <li key={task.id}>{task.taskName} · {task.status} · due {new Date(task.dueDate).toLocaleDateString()}</li>)}</ul>}</div>}
                      <div className="flex flex-wrap gap-1 mt-3">
                        {application.status === 'applied' && <button onClick={() => void handleScreen(application.id)} className="ui-button ui-button--soft">Screen</button>}
                        {application.status === 'screened' && <button onClick={() => void handlePropose(application)} className="ui-button ui-button--soft">Check & propose</button>}
                        {application.status === 'interviewing' && job && <div className="flex items-center gap-1"><label className="text-xs text-gray-600">Offer ({job.compBand.min.toLocaleString()}–{job.compBand.max.toLocaleString()} {job.compBand.currency})<input aria-label={`Offer amount for ${candidate?.name ?? application.candidateId}`} value={offerAmount} onChange={(event) => setOfferAmounts((previous) => ({ ...previous, [application.id]: event.target.value }))} type="number" min="0" required className="w-24 border rounded p-1 ml-1" /></label><button onClick={() => void handleOffer(application.id, offerAmount)} className="ui-button ui-button--success">Generate offer</button></div>}
                        {offer?.status === 'draft' && <button onClick={() => void handleSendOffer(offer.id)} className="ui-button ui-button--primary">Send offer</button>}
                        {appInterviews.length > 0 && <button onClick={() => void loadFeedbackSummary(application.id)} className="ui-button ui-button--soft">Load feedback</button>}
                        {acceptedOffer && !background && <button onClick={() => void handleBackgroundCheck(acceptedOffer.id)} className="ui-button ui-button--primary">Background check</button>}
                        {acceptedOffer && tasks.length === 0 && <button onClick={() => void handleChecklist(acceptedOffer.id)} className="ui-button ui-button--warning">Checklist</button>}
                        {acceptedOffer && <button onClick={() => void handleOnboardingStatus(acceptedOffer.id)} className="ui-button ui-button--warning">Refresh status</button>}
                        <button onClick={() => candidate && void handleProfile(candidate.id)} className="ui-button ui-button--secondary">Profile</button>
                      </div>
                      {schedulingAppId === application.id && <div className="mt-3 border-t pt-2 space-y-2"><div><p className="text-xs text-gray-500 mb-1">Common free slots ({commonSlots.length})</p>{commonSlots.length > 0 ? <p className="text-xs text-gray-600">{commonSlots.map((slot) => new Date(slot).toLocaleString()).join(' · ')}</p> : <p className="text-xs text-gray-400">No common slots returned.</p>}</div><div><p className="text-xs text-gray-500 mb-1">Proposed slots</p>{proposedSlots.length > 0 ? <div className="flex flex-wrap gap-1">{proposedSlots.map((proposed) => <button key={proposed.interviewId} onClick={() => void handleBook(application.id, proposed.slot)} className="text-xs border border-indigo-300 text-indigo-700 rounded px-2 py-1">{new Date(proposed.slot).toLocaleString()}</button>)}</div> : <p className="text-xs text-gray-400">No proposed slots.</p>}</div></div>}
                    </article>
                  );
                })}
                {column.applications.length === 0 && <p className="text-xs text-gray-400">No applications</p>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

const CandidateView = () => {
  const {
    jobs,
    candidates,
    applications,
    interviews,
    offers,
    backgroundChecks,
    benefitsEnrollments,
    onboardingTasks,
    catalogs
  } = useStore();
  const candidateId = 'cand-1';
  const candidate = candidates.find((item) => item.id === candidateId);
  const myApplications = applications.filter(
    (application) => application.candidateId === candidateId
  );
  const myOffers = offers.filter((offer) =>
    myApplications.some((application) => application.id === offer.applicationId)
  );
  const [faqAnswers, setFaqAnswers] = useState<
    Record<string, { answer: string; answeredFromData: boolean }>
  >({});
  const [counterAmounts, setCounterAmounts] = useState<Record<string, string>>({});
  const [benefitSelections, setBenefitSelections] = useState<
    Record<string, PlanSelections>
  >({});
  const [statusByOffer, setStatusByOffer] = useState<
    Record<string, GetOnboardingStatusOutput>
  >({});
  const [error, setError] = useOperationError();
  const actor = actorContextForRole('candidate');

  const run = async (operation: () => Promise<unknown>) => {
    try {
      setError(null);
      return await operation();
    } catch (caught) {
      setError(caught);
      return undefined;
    }
  };

  const handleApply = (jobId: string) => {
    if (!candidate) {
      setError(new Error('Candidate profile is still loading'));
      return;
    }
    void run(() =>
      operationClient.invoke(
        'submit_application',
        { candidateId, jobId, resumeText: candidate.resumeText },
        actor
      )
    );
  };

  const handleFaq = async (event: FormEvent<HTMLFormElement>, jobId: string) => {
    event.preventDefault();
    const question = String(new FormData(event.currentTarget).get('question') ?? '');
    const result = await run(() =>
      operationClient.invoke('answer_candidate_faq', { jobId, question }, actor)
    );
    if (result) {
      setFaqAnswers((previous) => ({
        ...previous,
        [jobId]: result as { answer: string; answeredFromData: boolean }
      }));
    }
  };

  const handleBook = (applicationId: string, slot: string) => {
    void run(() => operationClient.invoke('book_interview', { applicationId, slot }, actor));
  };

  const handleResponse = (
    offerId: string,
    decision: 'accept' | 'decline' | 'counter'
  ) => {
    void run(() =>
      decision === 'counter'
        ? operationClient.invoke(
            'respond_to_offer',
            {
              offerId,
              decision: 'counter',
              counterAmount: Number(counterAmounts[offerId])
            },
            actor
          )
        : operationClient.invoke('respond_to_offer', { offerId, decision }, actor)
    );
  };

  const handleBenefits = (offerId: string, selected: PlanSelections) => {
    void run(() =>
      operationClient.invoke('enroll_benefits', {
        offerId,
        planSelections: selected
      }, actor)
    );
  };

  const handleOnboardingStatus = async (offerId: string) => {
    const result = await run(() =>
      operationClient.invoke('get_onboarding_status', { offerId }, actor)
    );
    if (result) {
      setStatusByOffer((previous) => ({
        ...previous,
        [offerId]: result as GetOnboardingStatusOutput
      }));
    }
  };

  const persistedOnboardingStatus = (offerId: string) =>
    calculateOnboardingStatus({
      offerId,
      backgroundChecks,
      benefitsEnrollments,
      tasks: onboardingTasks
    });

  return (
    <div data-tour="role-view" className="page-shell">
      <header className="page-header">
        <div className="page-header__copy">
          <p className="page-header__eyebrow">Candidate workspace</p>
          <h1 className="page-title">Welcome, {candidate?.name}</h1>
          <p className="page-description">Track applications, choose interview times, review offers, and complete onboarding from one synchronized workspace.</p>
        </div>
        <div className="page-header__meta">
          <span className="status-pill status-pill--info">{myApplications.length} application{myApplications.length === 1 ? '' : 's'}</span>
          <span className="status-pill status-pill--neutral">Private candidate view</span>
        </div>
      </header>
      {error && (
        <div role="alert" className="callout callout--danger mb-5">
          {error}
        </div>
      )}

      <section aria-label="Your applications" data-candidate-applications className="page-section">
        <h2 className="section-heading__title">Your applications</h2>
        {myApplications.length === 0 ? (
          <p className="text-gray-500">No applications submitted yet.</p>
        ) : (
          <div className="space-y-3">
            {myApplications.map((application) => {
              const job = jobs.find((item) => item.id === application.jobId);
              return (
                <article
                  key={application.id}
                  data-application-id={application.id}
                  className="panel panel--padded"
                >
                  <div className="flex justify-between items-start gap-3">
                    <div>
                      <h3 className="font-semibold text-gray-900">
                        {job?.title ?? application.jobId}
                      </h3>
                      <p className="text-xs text-gray-500">
                        Submitted {new Date(application.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <span
                      data-application-status={application.status}
                      className="status-pill status-pill--primary capitalize"
                    >
                      {application.status.replaceAll('_', ' ')}
                    </span>
                  </div>
                  {application.screeningScore !== null && (
                    <p className="mt-2 text-sm text-gray-600">
                      Screening score: {application.screeningScore}%
                      {application.screeningRationale && ` · ${application.screeningRationale}`}
                    </p>
                  )}
                  <p data-application-confirmation className="mt-2 text-xs text-green-700">
                    Application submitted and synchronized with the recruiting team.
                  </p>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section aria-label="Interview schedule" data-candidate-interviews className="page-section">
        <h2 className="section-heading__title">Interview schedule</h2>
        {myApplications.every(
          (application) =>
            !interviews.some((interview) => interview.applicationId === application.id)
        ) ? (
          <p className="text-gray-500">No proposed or booked interview slots yet.</p>
        ) : (
          <div className="space-y-3">
            {myApplications.map((application) => {
              const job = jobs.find((item) => item.id === application.jobId);
              const proposed = interviews.filter(
                (interview) =>
                  interview.applicationId === application.id && interview.status === 'proposed'
              );
              const booked = interviews.filter(
                (interview) =>
                  interview.applicationId === application.id && interview.status === 'booked'
              );
              if (proposed.length === 0 && booked.length === 0) return null;
              return (
                <article
                  key={application.id}
                  data-application-id={application.id}
                  className="panel panel--padded candidate-interview-card"
                >
                  <h3 className="font-medium text-indigo-900">
                    {job?.title ?? application.jobId}
                  </h3>
                  {booked.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {booked.map((interview) => (
                        <p
                          key={interview.id}
                          data-interview-status="booked"
                          className="text-sm text-green-700"
                        >
                          Booked interview: {new Date(interview.slot).toLocaleString()}
                        </p>
                      ))}
                    </div>
                  )}
                  {proposed.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs text-indigo-700 mb-2">
                        Select one of the proposed slots:
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {proposed.map((interview) => (
                          <button
                            key={interview.id}
                            data-interview-status="proposed"
                            onClick={() => handleBook(application.id, interview.slot)}
                            className="ui-button ui-button--soft"
                          >
                            {new Date(interview.slot).toLocaleString()}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section aria-label="Your offers" data-candidate-offers className="page-section">
        <h2 className="section-heading__title">Your offers</h2>
        <div className="space-y-4">
          {myOffers.map((offer) => {
            const application = myApplications.find(
              (item) => item.id === offer.applicationId
            );
            const job = jobs.find((item) => item.id === application?.jobId);
            const background = backgroundChecks.find(
              (check) => check.offerId === offer.id
            );
            const enrollment = benefitsEnrollments.find(
              (item) => item.offerId === offer.id
            );
            const tasks = onboardingTasks.filter((task) => task.offerId === offer.id);
            const selected = enrollment?.planSelections ?? benefitSelections[offer.id] ?? {
              medical: catalogs.planCatalog.medical[0] ?? '',
              dental: catalogs.planCatalog.dental[0] ?? '',
              vision: catalogs.planCatalog.vision[0] ?? ''
            };
            const onboardingStatus = persistedOnboardingStatus(offer.id);
            const hasResponse =
              offer.status === 'accepted' ||
              offer.status === 'declined' ||
              offer.status === 'countered' ||
              offer.respondedAt !== null;
            return (
              <article
                key={offer.id}
                data-offer-id={offer.id}
                className="panel panel--padded candidate-offer-card"
              >
                <div
                  role="status"
                  data-offer-banner
                  className="mb-3 rounded-lg bg-white/70 border border-green-200 p-3 text-sm text-green-900"
                >
                  {offer.status === 'sent'
                    ? 'New offer available for your review.'
                    : `Offer status: ${offer.status.replaceAll('_', ' ')}`}
                </div>
                <div className="flex justify-between items-start gap-3">
                  <div>
                    <h3 className="font-bold text-green-900">
                      Offer for {job?.title ?? application?.jobId}
                    </h3>
                    <p className="text-green-800">
                      {offer.compAmount.toLocaleString()} {offer.currency}
                    </p>
                    {offer.compensationWarning && (
                      <p className="text-xs text-amber-700 mt-1">
                        Compensation note: {offer.compensationWarning}
                      </p>
                    )}
                  </div>
                  <span className="capitalize font-semibold">
                    {offer.status.replaceAll('_', ' ')}
                  </span>
                </div>

                {hasResponse && (
                  <div
                    role="status"
                    data-response-confirmation
                    className="mt-3 rounded-lg bg-white border border-green-200 p-3 text-sm text-green-800"
                  >
                    Response confirmed: {offer.status.replaceAll('_', ' ')}
                    {offer.status === 'countered' && offer.counterAmount !== null
                      ? ` at ${offer.counterAmount.toLocaleString()} ${offer.currency}`
                      : ''}
                    {offer.respondedAt && (
                      <span className="text-xs text-gray-500">
                        {' '}· {new Date(offer.respondedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                )}

                {offer.status === 'sent' && (
                  <div className="flex flex-wrap items-center gap-2 mt-4">
                    <button
                      onClick={() => handleResponse(offer.id, 'accept')}
                      className="ui-button ui-button--success"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => handleResponse(offer.id, 'decline')}
                      className="ui-button ui-button--secondary"
                    >
                      Decline
                    </button>
                    <label className="text-sm text-gray-700">
                      Counter offer
                      <input
                        aria-label={`Counter offer for ${job?.title ?? offer.id}`}
                        type="number"
                        min="0"
                        placeholder="Amount"
                        value={counterAmounts[offer.id] ?? ''}
                        onChange={(event) =>
                          setCounterAmounts((previous) => ({
                            ...previous,
                            [offer.id]: event.target.value
                          }))
                        }
                        className="w-28 border rounded px-2 py-2 ml-1"
                      />
                    </label>
                    <button
                      onClick={() => handleResponse(offer.id, 'counter')}
                      className="ui-button ui-button--secondary"
                    >
                      Counter
                    </button>
                  </div>
                )}

                {offer.status === 'accepted' && (
                  <div className="mt-4 pt-3 border-t border-green-200 text-sm space-y-3">
                    <p>Application status: {application?.status}</p>
                    <p
                      data-background-status={background?.status ?? 'not-started'}
                      className="inline-flex rounded-full bg-white border border-green-200 px-2 py-1"
                    >
                      Background check:{' '}
                      <strong className="ml-1">{background?.status ?? 'not started'}</strong>
                    </p>

                    <div data-plan-catalog className="rounded-lg bg-white/70 border border-green-100 p-3 space-y-2">
                      <h4 className="font-medium text-green-900">Benefits enrollment</h4>
                      <p className="text-xs text-gray-600">
                        Choose from the persisted medical, dental, and vision plan catalog.
                      </p>
                      <div className="inline-controls flex flex-wrap items-center gap-2">
                        <select
                          aria-label="Medical plan"
                          value={selected.medical}
                          disabled={Boolean(enrollment)}
                          onChange={(event) =>
                            setBenefitSelections((previous) => ({
                              ...previous,
                              [offer.id]: { ...selected, medical: event.target.value }
                            }))
                          }
                          className="border rounded px-2 py-1"
                        >
                          <option value="">Medical plan</option>
                          {catalogs.planCatalog.medical.map((plan) => (
                            <option key={plan} value={plan}>{plan}</option>
                          ))}
                        </select>
                        <select
                          aria-label="Dental plan"
                          value={selected.dental}
                          disabled={Boolean(enrollment)}
                          onChange={(event) =>
                            setBenefitSelections((previous) => ({
                              ...previous,
                              [offer.id]: { ...selected, dental: event.target.value }
                            }))
                          }
                          className="border rounded px-2 py-1"
                        >
                          <option value="">Dental plan</option>
                          {catalogs.planCatalog.dental.map((plan) => (
                            <option key={plan} value={plan}>{plan}</option>
                          ))}
                        </select>
                        <select
                          aria-label="Vision plan"
                          value={selected.vision}
                          disabled={Boolean(enrollment)}
                          onChange={(event) =>
                            setBenefitSelections((previous) => ({
                              ...previous,
                              [offer.id]: { ...selected, vision: event.target.value }
                            }))
                          }
                          className="border rounded px-2 py-1"
                        >
                          <option value="">Vision plan</option>
                          {catalogs.planCatalog.vision.map((plan) => (
                            <option key={plan} value={plan}>{plan}</option>
                          ))}
                        </select>
                        <button
                          disabled={Boolean(enrollment) || !selected.medical || !selected.dental || !selected.vision}
                          onClick={() => handleBenefits(offer.id, selected)}
                          className="text-green-700 underline disabled:text-gray-400 disabled:no-underline"
                        >
                          {enrollment ? 'Enrolled' : 'Enroll'}
                        </button>
                      </div>
                      {enrollment && (
                        <p data-benefits-confirmation className="text-xs text-green-700">
                          Enrollment recorded: {enrollment.planSelections.medical} ·{' '}
                          {enrollment.planSelections.dental} · {enrollment.planSelections.vision}
                        </p>
                      )}
                    </div>

                    <div data-onboarding-status={offer.id} className="rounded-lg bg-orange-50 border border-orange-100 p-3 space-y-2">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-medium text-orange-900">Onboarding progress</span>
                        <strong data-task-completion>
                          {onboardingStatus.taskCompletion.done}/{onboardingStatus.taskCompletion.total} complete ({onboardingStatus.completionPercentage}%)
                        </strong>
                      </div>
                      <p className="text-xs text-orange-800">
                        Background: {onboardingStatus.backgroundCheckStatus ?? 'not started'} · Benefits: {onboardingStatus.benefitsEnrolled ? 'enrolled' : 'not enrolled'}
                      </p>
                      {tasks.length > 0 ? (
                        <ul className="text-xs space-y-1">
                          {tasks.map((task) => (
                            <li key={task.id} data-task-status={task.status}>
                              {task.taskName} · {task.status} · due {new Date(task.dueDate).toLocaleDateString()}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-gray-500">No onboarding checklist has been generated yet.</p>
                      )}
                      <div className="inline-controls flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => void handleOnboardingStatus(offer.id)}
                          className="text-orange-700 underline"
                        >
                          Refresh onboarding status
                        </button>
                        {statusByOffer[offer.id] && (
                          <span data-onboarding-operation-response className="text-xs text-orange-800">
                            Server status refreshed: {statusByOffer[offer.id].completionPercentage}% complete
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
          {myOffers.length === 0 && <p className="text-gray-500">No offers yet.</p>}
        </div>
      </section>

      <section aria-label="Open roles" className="page-section">
        <h2 className="section-heading__title">Open roles</h2>
        <div className="space-y-4">
          {jobs.filter((job) => job.status === 'open').map((job) => {
            const application = myApplications.find((item) => item.jobId === job.id);
            return (
              <article key={job.id} className="panel panel--padded">
                <div className="flex justify-between items-start gap-3">
                  <div>
                    <h3 className="font-semibold text-lg">{job.title}</h3>
                    <p className="text-sm text-gray-500">
                      {job.department} · {job.compBand.min.toLocaleString()}–{job.compBand.max.toLocaleString()} {job.compBand.currency}
                    </p>
                  </div>
                  {application ? (
                    <span className="text-green-700 flex items-center gap-1 text-sm">
                      <CheckCircle className="w-4 h-4" /> Application {application.status.replaceAll('_', ' ')}
                    </span>
                  ) : (
                    <button
                      onClick={() => handleApply(job.id)}
                      className="ui-button ui-button--primary"
                    >
                      Apply
                    </button>
                  )}
                </div>
                <form onSubmit={(event) => void handleFaq(event, job.id)} className="faq-form flex gap-2 mt-4">
                  <input
                    name="question"
                    required
                    placeholder="Ask about requirements or compensation"
                    className="flex-1 border rounded p-2 text-sm"
                  />
                  <button type="submit" className="ui-button ui-button--secondary">Ask</button>
                </form>
                {faqAnswers[job.id] && (
                  <div className="mt-2 text-sm p-2 rounded bg-blue-50">
                    <p>{faqAnswers[job.id].answer}</p>
                    <span className="text-xs text-blue-700">
                      answeredFromData: {String(faqAnswers[job.id].answeredFromData)}
                    </span>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
};

const HiringManagerView = () => {
  const {
    interviews,
    applications,
    candidates,
    jobs,
    scorecards
  } = useStore();
  const [kits, setKits] = useState<Record<string, GetInterviewKitOutput>>({});
  const [summaries, setSummaries] = useState<Record<string, GetPanelFeedbackSummaryOutput>>({});
  const [candidateProfiles, setCandidateProfiles] = useState<Record<string, GetCandidateProfileOutput>>({});
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const profileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [error, setErrorState] = useState<string | null>(null);
  const actor = actorContextForRole('hiring-manager');

  useEffect(() => {
    if (!selectedCandidateId) return undefined;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    profileCloseButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedCandidateId(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [selectedCandidateId]);

  const recommendations = ['strong_yes', 'yes', 'no', 'strong_no'] as const;
  const feedbackInterviews = interviews.filter(
    (interview) => interview.status === 'booked' || interview.status === 'completed'
  );

  const run = async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    try {
      setErrorState(null);
      return await operation();
    } catch (caught) {
      setErrorState(errorMessage(caught));
      return undefined;
    }
  };

  const loadKit = async (jobId: string) => {
    const result = await run(() =>
      operationClient.invoke('get_interview_kit', { jobId }, actor)
    );
    if (result) {
      setKits((previous) => ({ ...previous, [jobId]: result }));
    }
  };

  const loadSummary = async (applicationId: string) => {
    const result = await run(() =>
      operationClient.invoke('get_panel_feedback_summary', { applicationId }, actor)
    );
    if (result) {
      setSummaries((previous) => ({ ...previous, [applicationId]: result }));
    }
  };

  const loadCandidateProfile = async (candidateId: string) => {
    const result = await run(() =>
      operationClient.invoke('get_candidate_profile', { candidateId }, actor)
    );
    if (result) {
      setCandidateProfiles((previous) => ({ ...previous, [candidateId]: result }));
      setSelectedCandidateId(candidateId);
    }
  };

  const setValidationError = (interviewId: string, message: string | null) => {
    setValidationErrors((previous) => {
      const next = { ...previous };
      if (message === null) delete next[interviewId];
      else next[interviewId] = message;
      return next;
    });
  };

  const submitFeedback = async (
    event: FormEvent<HTMLFormElement>,
    interviewId: string,
    jobId: string,
    applicationId?: string
  ) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const competencies = kits[jobId]?.competencies ?? [];

    if (competencies.length === 0) {
      setValidationError(interviewId, 'Load the interview kit before submitting feedback.');
      return;
    }

    const competencyScores: Record<string, number> = {};
    for (const competency of competencies) {
      const rawScore = data.get(`score-${competency.name}`);
      const score = typeof rawScore === 'string' ? Number(rawScore) : Number.NaN;
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        setValidationError(
          interviewId,
          `${competency.name} score must be a whole number from 1 through 5.`
        );
        return;
      }
      competencyScores[competency.name] = score;
    }

    const recommendationValue = String(data.get('recommendation') ?? '');
    if (!recommendations.includes(recommendationValue as (typeof recommendations)[number])) {
      setValidationError(interviewId, 'Select a valid interviewer recommendation.');
      return;
    }

    const comments = String(data.get('comments') ?? '').trim();
    if (!comments) {
      setValidationError(interviewId, 'Comments are required before submitting feedback.');
      return;
    }

    setValidationError(interviewId, null);
    const result = await run(() =>
      operationClient.invoke(
        'submit_interview_feedback',
        {
          interviewId,
          interviewer: actor.actorId,
          competencyScores,
          recommendation: recommendationValue as (typeof recommendations)[number],
          comments
        },
        actor
      )
    );

    if (result) {
      form.reset();
      if (applicationId) await loadSummary(applicationId);
    }
  };

  const selectedProfile = selectedCandidateId
    ? candidateProfiles[selectedCandidateId]
    : undefined;

  return (
    <div data-tour="role-view" className="page-shell">
      <header className="page-header">
        <div className="page-header__copy">
          <p className="page-header__eyebrow">Hiring manager workspace</p>
          <h1 className="page-title">Interview room</h1>
          <p className="page-description">Prepare from the persisted role template, review canonical candidate context, and submit validated scorecards for booked interviews.</p>
        </div>
        <div className="page-header__meta">
          <span className="status-pill status-pill--info">{feedbackInterviews.length} interview{feedbackInterviews.length === 1 ? '' : 's'} ready</span>
          <span className="status-pill status-pill--neutral">Validated scorecards</span>
        </div>
      </header>
      {error && (
        <div role="alert" className="callout callout--danger mb-5">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 page-section">
        <WorkflowStatusPanel actor={actor} role="hiring-manager" />
        <CandidateComparisonPanel actor={actor} role="hiring-manager" />
      </div>

      {selectedProfile && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Candidate profile for ${selectedProfile.name}`}
          className="modal-backdrop fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
        >
          <div className="modal-panel bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto shadow-2xl p-6">
            <div className="flex justify-between items-start mb-5">
              <div>
                <h2 className="text-xl font-bold">{selectedProfile.name}</h2>
                <p className="text-sm text-gray-500">{selectedProfile.email}</p>
              </div>
              <button
                ref={profileCloseButtonRef}
                type="button"
                className="icon-button"
                onClick={() => setSelectedCandidateId(null)}
                aria-label="Close candidate profile"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm mb-4">
              Skills: {selectedProfile.skills.join(', ')} · {selectedProfile.experienceYears} years'
              experience
            </p>
            <pre className="text-sm bg-gray-50 rounded p-3 whitespace-pre-wrap">
              {selectedProfile.resumeText}
            </pre>
            <h3 className="font-semibold mt-5 mb-2">Application history</h3>
            {selectedProfile.applicationHistory.length === 0 ? (
              <p className="text-sm text-gray-500">No applications found.</p>
            ) : (
              <ul className="space-y-2">
                {selectedProfile.applicationHistory.map((application) => (
                  <li key={application.id} className="border rounded p-2 text-sm">
                    <div className="flex justify-between gap-2">
                      <span>{application.jobId}</span>
                      <span>{application.status}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <section aria-label="Interview feedback" className="page-section">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="text-lg font-semibold">Interview feedback</h2>
          <span className="text-xs text-gray-500">
            {feedbackInterviews.length} booked or completed
          </span>
        </div>
        {feedbackInterviews.length === 0 && (
          <p className="text-gray-500">No booked or completed interviews are ready for feedback.</p>
        )}
        <div className="space-y-4">
          {feedbackInterviews.map((interview) => {
            const application = applications.find((item) => item.id === interview.applicationId);
            const candidate = candidates.find((item) => item.id === application?.candidateId);
            const job = jobs.find((item) => item.id === application?.jobId);
            const kit = job ? kits[job.id] : undefined;
            const savedScorecards = scorecards.filter(
              (scorecard) => scorecard.interviewId === interview.id
            );
            const summary = application ? summaries[application.id] : undefined;
            const summaryScorecards = summary?.scorecards.filter(
              (scorecard) => scorecard.interviewId === interview.id
            ) ?? [];
            const displayedScorecards = savedScorecards.length > 0
              ? savedScorecards
              : summaryScorecards;
            const validationError = validationErrors[interview.id];
            const completed = interview.status === 'completed';

            return (
              <article
                key={interview.id}
                data-interview-id={interview.id}
                className="panel panel--padded"
              >
                <div className="flex justify-between items-start gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{candidate?.name ?? application?.candidateId}</h3>
                      <span
                        role="status"
                        data-interview-status={interview.status}
                        className={`text-xs rounded-full px-2 py-1 ${completed ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}
                      >
                        {completed ? 'completed' : 'booked'}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500">
                      {job?.title ?? application?.jobId} · {new Date(interview.slot).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {candidate && (
                      <button
                        type="button"
                        onClick={() => void loadCandidateProfile(candidate.id)}
                        className="text-gray-700 text-sm underline"
                      >
                        View candidate profile
                      </button>
                    )}
                    {job && (
                      <button
                        type="button"
                        onClick={() => void loadKit(job.id)}
                        className="text-blue-700 text-sm underline"
                      >
                        {kit ? 'Refresh interview kit' : 'Load interview kit'}
                      </button>
                    )}
                  </div>
                </div>

                <div
                  data-interview-completion={interview.status}
                  className={`mt-3 rounded-lg border p-3 text-sm ${completed ? 'bg-green-50 border-green-100 text-green-800' : 'bg-blue-50 border-blue-100 text-blue-800'}`}
                >
                  {completed
                    ? 'Interview completed. Persisted scorecards are shown below.'
                    : 'Interview is booked. Complete the role-specific scorecard after the interview.'}
                </div>

                {kit ? (
                  <section
                    data-interview-kit={job?.id}
                    aria-label="Interview kit"
                    className="bg-blue-50 rounded p-3 mt-3 text-sm space-y-3"
                  >
                    <h4 className="font-semibold text-blue-900">Competencies and questions</h4>
                    {kit.competencies.map((competency) => (
                      <div key={competency.name} data-competency={competency.name}>
                        <strong>{competency.name}</strong>
                        <ul className="list-disc pl-5 text-blue-900">
                          {competency.questions.map((question) => (
                            <li key={question}>{question}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </section>
                ) : (
                  <p className="mt-3 text-sm text-gray-500">
                    Load the interview kit to see competency questions and enable scorecard validation.
                  </p>
                )}

                {kit && (
                  <form
                    onSubmit={(event) =>
                      void submitFeedback(event, interview.id, job?.id ?? '', application?.id)
                    }
                    className="mt-4 border-t pt-4 space-y-3"
                  >
                    <h4 className="font-medium">
                      {completed ? 'Add interviewer scorecard' : 'Submit scorecard'}
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {kit.competencies.map((competency) => (
                        <label key={competency.name} className="text-sm">
                          {competency.name} score
                          <select
                            name={`score-${competency.name}`}
                            defaultValue="3"
                            className="block w-full border rounded p-2"
                            aria-label={`${competency.name} score`}
                          >
                            <option value="1">1</option>
                            <option value="2">2</option>
                            <option value="3">3</option>
                            <option value="4">4</option>
                            <option value="5">5</option>
                          </select>
                        </label>
                      ))}
                    </div>
                    <label className="text-sm block">
                      Recommendation
                      <select
                        name="recommendation"
                        defaultValue="yes"
                        className="w-full border rounded p-2"
                        aria-label="Interview recommendation"
                      >
                        {recommendations.map((recommendation) => (
                          <option key={recommendation} value={recommendation}>
                            {recommendation.replaceAll('_', ' ')}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm block">
                      Comments
                      <textarea
                        name="comments"
                        required
                        placeholder="Comments"
                        className="w-full border rounded p-2"
                        aria-label="Interview comments"
                      />
                    </label>
                    {validationError && (
                      <p
                        role="alert"
                        data-scorecard-validation-error={interview.id}
                        className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2"
                      >
                        {validationError}
                      </p>
                    )}
                    <button type="submit" className="bg-green-600 text-white rounded px-3 py-2">
                      {completed ? 'Save additional scorecard' : 'Submit scorecard'}
                    </button>
                  </form>
                )}

                {displayedScorecards.length > 0 ? (
                  <section
                    data-saved-scorecards={interview.id}
                    aria-label="Saved scorecards"
                    className="mt-4 border-t pt-3 space-y-2"
                  >
                    <h4 className="font-medium">Saved scorecards ({displayedScorecards.length})</h4>
                    {displayedScorecards.map((scorecard) => (
                      <article
                        key={scorecard.id}
                        data-scorecard-id={scorecard.id}
                        className="rounded-lg bg-green-50 border border-green-100 p-3 text-sm"
                      >
                        <div className="flex flex-wrap justify-between gap-2 text-green-900">
                          <strong>{scorecard.interviewer}</strong>
                          <span>{scorecard.recommendation.replaceAll('_', ' ')}</span>
                        </div>
                        <p className="text-xs text-gray-600 mt-1">
                          Submitted {new Date(scorecard.submittedAt).toLocaleString()}
                        </p>
                        <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs">
                          {Object.entries(scorecard.competencyScores).map(([competency, score]) => (
                            <div key={competency}>
                              <dt className="inline font-semibold">{competency}</dt>
                              <dd className="inline">: {score}/5</dd>
                            </div>
                          ))}
                        </dl>
                        <p className="mt-2 text-gray-700">{scorecard.comments}</p>
                      </article>
                    ))}
                  </section>
                ) : completed ? (
                  <p className="mt-4 text-sm text-gray-500">
                    Interview is completed, but no saved scorecard is available in the shared snapshot yet.
                  </p>
                ) : null}

                {application && (
                  <div className="mt-4 border-t pt-3">
                    <button
                      type="button"
                      onClick={() => void loadSummary(application.id)}
                      className="text-sm text-indigo-700 underline"
                    >
                      {summary ? 'Refresh panel summary' : 'Load panel summary'}
                    </button>
                    {summary && (
                      <div data-panel-summary={application.id} className="mt-2">
                        <FeedbackSummaryPanel summary={summary} />
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
};

export interface AppProps {
  bootError?: string | null;
}

export default function App({ bootError = null }: AppProps = {}) {
  const currentRole = useStore((state) => state.currentRole);
  const [tourOpen, setTourOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const roleLabel = currentRole === 'hiring-manager'
    ? 'Hiring manager'
    : currentRole.charAt(0).toUpperCase() + currentRole.slice(1);

  useEffect(() => {
    if (!mobileNavOpen && !activityOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMobileNavOpen(false);
      setActivityOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activityOpen, mobileNavOpen]);

  return (
    <div className="app-shell">
      <Navigation
        mobileOpen={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        onStartTour={() => { setTourOpen(true); setMobileNavOpen(false); }}
      />
      {mobileNavOpen && (
        <button
          type="button"
          className="mobile-shell-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <main data-tour="main-workflow" className="app-main tour-main-content">
        <div className="mobile-shell-toolbar">
          <button
            type="button"
            className="icon-button"
            aria-label="Open navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => { setActivityOpen(false); setMobileNavOpen(true); }}
          >
            <Menu className="h-4 w-4" />
          </button>
          <span className="mobile-shell-toolbar__title">PipelineOS <span className="text-slate-400">/</span> {roleLabel}</span>
          <div className="mobile-shell-toolbar__actions">
            <button
              type="button"
              className="icon-button"
              aria-label="Open activity feed"
              aria-expanded={activityOpen}
              onClick={() => { setMobileNavOpen(false); setActivityOpen(true); }}
            >
              <Activity className="h-4 w-4" />
            </button>
          </div>
        </div>
        {bootError && <div className="callout callout--danger m-4">{bootError}</div>}
        {currentRole === 'recruiter' && <RecruiterView />}
        {currentRole === 'candidate' && <CandidateView />}
        {currentRole === 'hiring-manager' && <HiringManagerView />}
        {currentRole === 'documentation' && <DocumentationView />}
      </main>
      {activityOpen && (
        <button
          type="button"
          className="mobile-shell-backdrop"
          aria-label="Close activity feed"
          onClick={() => setActivityOpen(false)}
        />
      )}
      <LiveActivityFeed open={activityOpen} onClose={() => setActivityOpen(false)} />
      <AppTour
        open={tourOpen}
        includeDocumentation={currentRole === 'documentation'}
        onClose={() => setTourOpen(false)}
      />
    </div>
  );
}