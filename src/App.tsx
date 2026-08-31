import { useMemo, useState, type FormEvent } from 'react';
import { Activity, Book, Briefcase, CheckCircle, FileText, HelpCircle, User, Users, X } from 'lucide-react';
import { AppTour } from './components/AppTour';
import LivePublicJobsPanel from './components/LivePublicJobsPanel';
import { useStore } from './lib/store';
import { projectActivityFeed, projectKanban } from './lib/viewModels';
import { actorContextForRole } from './client/actorContext';
import { operationClient } from './client/operationClient';
import { PipelineError } from './shared/errors';
import { calculateOnboardingStatus } from './shared/domain/onboarding';
import type {
  CandidateSearchResult,
  CheckInterviewerAvailabilityOutput,
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

const LiveActivityFeed = () => {
  const activityLog = useStore((state) => state.activityLog);
  const entries = projectActivityFeed(activityLog);

  return (
    <aside aria-label="Live Activity Feed" data-tour="activity-feed" className="w-96 bg-gray-50 border-l border-gray-200 h-full overflow-y-auto flex flex-col tour-agent-log">
      <div className="p-4 border-b border-gray-200 bg-white sticky top-0 font-medium flex items-center gap-2">
        <Activity className="w-4 h-4 text-blue-600" /> Live Activity Feed
      </div>
      <div className="p-4 flex-1 space-y-3">
        {entries.map((entry) => (
          <article key={entry.id} data-activity-id={entry.id} className="text-sm bg-white border border-gray-200 rounded-lg p-3 shadow-sm">
            <div className="flex justify-between items-start gap-2 mb-1">
              <span className="font-medium text-gray-800 break-all">{entry.operation}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${entry.error ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                {entry.error ? entry.error.code : 'success'}
              </span>
            </div>
            <dl className="text-xs text-gray-500 space-y-1">
              <div><dt className="inline font-semibold">actor</dt><dd className="inline"> {entry.actorType} · {entry.actorId}</dd></div>
              <div><dt className="inline font-semibold">timestamp</dt><dd className="inline"> {entry.timestamp}</dd></div>
            </dl>
            <div className="mt-2 space-y-1 text-xs font-mono">
              <div><strong>input</strong><pre className="mt-1 bg-gray-50 p-2 rounded overflow-x-auto">{json(entry.input)}</pre></div>
              <div><strong>{entry.error ? 'error' : 'output'}</strong><pre className="mt-1 bg-gray-50 p-2 rounded overflow-x-auto">{json(entry.error ?? entry.output)}</pre></div>
            </div>
          </article>
        ))}
        {entries.length === 0 && (
          <div className="text-sm text-gray-400 text-center py-8">No activity yet.</div>
        )}
      </div>
    </aside>
  );
};

interface NavigationProps {
  onStartTour: () => void;
}

const Navigation = ({ onStartTour }: NavigationProps) => {
  const { currentRole, setRole, resetState } = useStore();
  const [resetError, setResetError] = useState<string | null>(null);

  const reset = async () => {
    try {
      setResetError(null);
      await resetState();
    } catch (error) {
      setResetError(errorMessage(error));
    }
  };

  const roles = [
    ['recruiter', Users, 'Recruiter'],
    ['candidate', User, 'Candidate'],
    ['hiring-manager', FileText, 'Hiring Manager'],
    ['documentation', Book, 'Documentation']
  ] as const;

  return (
    <nav aria-label="Primary navigation" className="bg-slate-900 text-white w-64 flex flex-col h-full">
      <div data-tour="brand" className="p-4 flex items-center gap-2 border-b border-slate-800">
        <Briefcase className="w-6 h-6 text-blue-400" />
        <span className="font-bold text-lg tracking-tight">PipelineOS</span>
      </div>
      <div data-tour="role-switcher" className="flex-1 py-6 px-3 space-y-1 tour-role-switcher">
        <div className="px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">View As</div>
        {roles.map(([role, Icon, label]) => (
          <button
            key={role}
            onClick={() => setRole(role)}
            data-tour={role === 'documentation' ? 'documentation-nav' : undefined}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${currentRole === role ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
          >
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>
      <div className="p-4 border-t border-slate-800 space-y-2">
        <button onClick={onStartTour} data-tour="start-tour" className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-400">
          <HelpCircle className="w-4 h-4" /> Start Tour
        </button>
        <button onClick={reset} data-tour="reset-demo" className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-400">
          Reset DB (Demo)
        </button>
        {resetError && <p className="text-xs text-red-300">{resetError}</p>}
      </div>
    </nav>
  );
};

const DocumentationView = () => {
  const descriptors = OPERATION_NAMES.map((name) => OPERATION_REGISTRY[name]);
  return (
    <div data-tour="role-view" className="p-8 max-w-5xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">WebMCP Tools Documentation</h1>
        <p className="text-gray-500">The documentation is rendered from the same 19 descriptors registered with WebMCP.</p>
      </div>
      <div data-tour="documentation-registry" className="space-y-6">
        {descriptors.map((tool) => (
          <article key={tool.name} className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <div className="flex items-center justify-between gap-3 mb-2">
              <h2 className="text-lg font-bold text-gray-900 font-mono text-blue-600">{tool.name}</h2>
              <span className="text-xs rounded-full px-2 py-1 bg-slate-100 text-slate-600">{tool.readOnly ? 'read-only' : 'mutation'}</span>
            </div>
            <p className="text-gray-700 mb-4">{tool.description}</p>
            <pre className="bg-slate-50 p-4 rounded-lg border border-slate-200 overflow-x-auto text-sm text-slate-800 font-mono whitespace-pre-wrap">
              {json({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations })}
            </pre>
          </article>
        ))}
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
  const [searchResults, setSearchResults] = useState<CandidateSearchResult[]>([]);
  const [profile, setProfile] = useState<GetCandidateProfileOutput | null>(null);
  const [feedbackSummaries, setFeedbackSummaries] = useState<Record<string, GetPanelFeedbackSummaryOutput>>({});
  const [commonSlotsByApplication, setCommonSlotsByApplication] = useState<Record<string, CheckInterviewerAvailabilityOutput['commonFreeSlots']>>({});
  const [proposedSlotsByApplication, setProposedSlotsByApplication] = useState<Record<string, ProposeInterviewSlotsOutput['proposedSlots']>>({});
  const [schedulingAppId, setSchedulingAppId] = useState<string | null>(null);
  const [offerAmounts, setOfferAmounts] = useState<Record<string, string>>({});
  const [onboardingStatus, setOnboardingStatus] = useState<Record<string, GetOnboardingStatusOutput>>({});
  const [error, setError] = useOperationError();
  const actor = actorContextForRole('recruiter');

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

  const handleSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const rawLevel = String(data.get('experienceLevel') ?? '');
    const experienceLevel = rawLevel === 'junior' || rawLevel === 'mid' || rawLevel === 'senior' ? rawLevel : undefined;
    const result = await run(() => operationClient.invoke('search_candidates', {
      query: String(data.get('query') ?? '') || undefined,
      skills: String(data.get('skills') ?? '').split(',').map((value) => value.trim()).filter(Boolean),
      experienceLevel
    }, actor));
    if (result) setSearchResults((result as { results: CandidateSearchResult[] }).results);
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
    <div data-tour="role-view" className="p-8 max-w-7xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Recruiter Dashboard</h1>
        <p className="text-gray-500">All cards, offers, interviews, and activity are projections of persisted Shared_State.</p>
      </div>
      {error && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}
      <LivePublicJobsPanel />

      {profile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto shadow-2xl p-6">
            <div className="flex justify-between items-start mb-5">
              <div><h2 className="text-xl font-bold">{profile.name}</h2><p className="text-sm text-gray-500">{profile.email}</p></div>
              <button onClick={() => setProfile(null)} aria-label="Close profile"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm mb-4">Skills: {profile.skills.join(', ')}</p>
            <pre className="text-sm bg-gray-50 rounded p-3 whitespace-pre-wrap">{profile.resumeText}</pre>
            <h3 className="font-semibold mt-5 mb-2">Application history</h3>
            {profile.applicationHistory.length === 0 ? <p className="text-sm text-gray-500">No applications found.</p> : <ul className="space-y-2">{profile.applicationHistory.map((application) => <li key={application.id} className="border rounded p-2 text-sm"><div className="flex justify-between gap-2"><span>{application.jobId}</span><span>{application.status}</span></div>{feedbackSummaries[application.id] && <FeedbackSummaryPanel summary={feedbackSummaries[application.id]} />}</li>)}</ul>}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form onSubmit={handleCreateReq} className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm space-y-3">
          <h2 className="text-lg font-semibold border-b pb-2">New requisition</h2>
          <input name="title" placeholder="Job title" required className="w-full border rounded p-2 text-sm" />
          <input name="department" placeholder="Department" required className="w-full border rounded p-2 text-sm" />
          <input name="requirements" placeholder="Requirements (comma separated)" required className="w-full border rounded p-2 text-sm" />
          <div className="flex gap-2"><input name="min" type="number" placeholder="Min" required className="w-full border rounded p-2 text-sm" /><input name="max" type="number" placeholder="Max" required className="w-full border rounded p-2 text-sm" /><input name="currency" defaultValue="USD" required className="w-24 border rounded p-2 text-sm" /></div>
          <button className="w-full bg-blue-600 text-white rounded p-2 text-sm font-medium">Create requisition</button>
        </form>
        <form onSubmit={handleSearch} className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm space-y-3">
          <h2 className="text-lg font-semibold border-b pb-2">Source candidates</h2>
          <input name="query" placeholder="Query" className="w-full border rounded p-2 text-sm" />
          <input name="skills" placeholder="Skills (comma separated)" className="w-full border rounded p-2 text-sm" />
          <select name="experienceLevel" className="w-full border rounded p-2 text-sm bg-white"><option value="">Any experience</option><option value="junior">Junior</option><option value="mid">Mid</option><option value="senior">Senior</option></select>
          <button className="w-full bg-indigo-600 text-white rounded p-2 text-sm font-medium">Search</button>
          <div className="space-y-2">{searchResults.map((result) => <div key={result.candidateId} className="border rounded p-3 text-sm"><div className="flex justify-between"><strong>{result.name}</strong><span>{result.matchScore}</span></div><p className="text-gray-600">{result.rationale}</p><button type="button" onClick={() => handleProfile(result.candidateId)} className="text-blue-600 text-xs">Open profile</button></div>)}</div>
        </form>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-4">Requisitions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{jobs.map((job) => <div key={job.id} className="bg-white p-5 rounded-xl border border-gray-200"><div className="flex justify-between"><h3 className="font-semibold">{job.title}</h3><span className="text-xs text-green-700">{job.status}</span></div><p className="text-sm text-gray-500">{job.department} · {job.compBand.min.toLocaleString()}–{job.compBand.max.toLocaleString()} {job.compBand.currency}</p><p className="text-sm text-gray-600 mt-2">{applications.filter((application) => application.jobId === job.id).length} applications</p></div>)}</div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-4"><h2 className="text-lg font-semibold">Pipeline Kanban</h2><span className="text-xs text-gray-500">Columns follow persisted application status</span></div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {columns.map((column) => (
            <div key={column.status} data-status={column.status} className="bg-gray-50 border border-gray-200 rounded-xl p-3 min-h-36">
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
                    <article key={application.id} className="bg-white rounded-lg border p-3 shadow-sm text-sm">
                      <div className="flex justify-between gap-2"><strong>{candidate?.name ?? application.candidateId}</strong><span className="text-xs text-gray-500">{application.status}</span></div>
                      {application.screeningScore !== null && <div className="text-xs text-gray-600 mt-1"><p>Screening: {application.screeningScore}%</p>{application.screeningRationale && <p className="text-gray-500">{application.screeningRationale}</p>}</div>}
                      {offer && <div className="text-xs mt-1"><p>Offer: {offer.status} · {offer.compAmount.toLocaleString()} {offer.currency}</p>{offer.compensationWarning && <p className="text-amber-700">Compensation warning: {offer.compensationWarning}</p>}</div>}
                      {bookedInterviews.length > 0 && <p className="text-xs mt-1 text-green-700">Booked slots: {bookedInterviews.map((interview) => new Date(interview.slot).toLocaleString()).join(' · ')}</p>}
                      {appInterviews.some((interview) => interview.status === 'completed') && <p className="text-xs mt-1 text-indigo-700">Interview feedback submitted</p>}
                      {feedbackSummary && <FeedbackSummaryPanel summary={feedbackSummary} />}
                      {acceptedOffer && <div className="mt-2 rounded bg-orange-50 border border-orange-100 p-2 text-xs"><p>Background check: <strong>{background?.status ?? 'not started'}</strong> · Benefits: <strong>{status ? (status.benefitsEnrolled ? 'enrolled' : 'not enrolled') : (benefits ? 'enrolled' : 'not enrolled')}</strong></p><p>Tasks: <strong>{status ? `${status.taskCompletion.done}/${status.taskCompletion.total} complete (${status.completionPercentage}%)` : `${tasks.filter((task) => task.status === 'complete').length}/${tasks.length} complete`}</strong></p>{tasks.length > 0 && <ul className="mt-1 space-y-1">{tasks.map((task) => <li key={task.id}>{task.taskName} · {task.status} · due {new Date(task.dueDate).toLocaleDateString()}</li>)}</ul>}</div>}
                      <div className="flex flex-wrap gap-1 mt-3">
                        {application.status === 'applied' && <button onClick={() => void handleScreen(application.id)} className="text-blue-700 bg-blue-50 px-2 py-1 rounded text-xs">Screen</button>}
                        {application.status === 'screened' && <button onClick={() => void handlePropose(application)} className="text-indigo-700 bg-indigo-50 px-2 py-1 rounded text-xs">Check & propose</button>}
                        {application.status === 'interviewing' && job && <div className="flex items-center gap-1"><label className="text-xs text-gray-600">Offer ({job.compBand.min.toLocaleString()}–{job.compBand.max.toLocaleString()} {job.compBand.currency})<input aria-label={`Offer amount for ${candidate?.name ?? application.candidateId}`} value={offerAmount} onChange={(event) => setOfferAmounts((previous) => ({ ...previous, [application.id]: event.target.value }))} type="number" min="0" required className="w-24 border rounded p-1 ml-1" /></label><button onClick={() => void handleOffer(application.id, offerAmount)} className="text-green-700 bg-green-50 px-2 py-1 rounded text-xs">Generate offer</button></div>}
                        {offer?.status === 'draft' && <button onClick={() => void handleSendOffer(offer.id)} className="text-purple-700 bg-purple-50 px-2 py-1 rounded text-xs">Send offer</button>}
                        {appInterviews.length > 0 && <button onClick={() => void loadFeedbackSummary(application.id)} className="text-indigo-700 bg-indigo-50 px-2 py-1 rounded text-xs">Load feedback</button>}
                        {acceptedOffer && !background && <button onClick={() => void handleBackgroundCheck(acceptedOffer.id)} className="text-purple-700 bg-purple-50 px-2 py-1 rounded text-xs">Background check</button>}
                        {acceptedOffer && tasks.length === 0 && <button onClick={() => void handleChecklist(acceptedOffer.id)} className="text-orange-700 bg-orange-50 px-2 py-1 rounded text-xs">Checklist</button>}
                        {acceptedOffer && <button onClick={() => void handleOnboardingStatus(acceptedOffer.id)} className="text-orange-700 bg-orange-50 px-2 py-1 rounded text-xs">Refresh status</button>}
                        <button onClick={() => candidate && void handleProfile(candidate.id)} className="text-gray-700 bg-gray-100 px-2 py-1 rounded text-xs">Profile</button>
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
    <div data-tour="role-view" className="p-8 max-w-5xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome, {candidate?.name}
        </h1>
        <p className="text-gray-500">
          Applications, interviews, offers, and onboarding use the persisted shared snapshot.
        </p>
      </div>
      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      <section aria-label="Your applications" data-candidate-applications>
        <h2 className="text-lg font-semibold mb-3">Your applications</h2>
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
                  className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm"
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
                      className="text-xs rounded-full px-2 py-1 bg-blue-50 text-blue-700 capitalize"
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

      <section aria-label="Interview schedule" data-candidate-interviews>
        <h2 className="text-lg font-semibold mb-3">Interview schedule</h2>
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
                  className="bg-indigo-50 border border-indigo-100 rounded-xl p-4"
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
                            className="px-3 py-2 bg-white border border-indigo-200 text-indigo-700 rounded-lg text-sm"
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

      <section aria-label="Your offers" data-candidate-offers>
        <h2 className="text-lg font-semibold mb-3">Your offers</h2>
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
                className="bg-green-50 border border-green-200 p-5 rounded-xl shadow-sm"
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
                      className="px-3 py-2 bg-green-600 text-white rounded"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => handleResponse(offer.id, 'decline')}
                      className="px-3 py-2 bg-white border rounded"
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
                      className="px-3 py-2 bg-white border rounded"
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
                      <div className="flex flex-wrap items-center gap-2">
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
                      <div className="flex flex-wrap items-center gap-2">
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

      <section aria-label="Open roles">
        <h2 className="text-lg font-semibold mb-3">Open roles</h2>
        <div className="space-y-4">
          {jobs.filter((job) => job.status === 'open').map((job) => {
            const application = myApplications.find((item) => item.jobId === job.id);
            return (
              <article key={job.id} className="bg-white p-5 rounded-xl border border-gray-200">
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
                      className="px-3 py-2 bg-blue-600 text-white rounded"
                    >
                      Apply
                    </button>
                  )}
                </div>
                <form onSubmit={(event) => void handleFaq(event, job.id)} className="flex gap-2 mt-4">
                  <input
                    name="question"
                    required
                    placeholder="Ask about requirements or compensation"
                    className="flex-1 border rounded p-2 text-sm"
                  />
                  <button className="px-3 py-2 bg-slate-200 rounded text-sm">Ask</button>
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
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [error, setErrorState] = useState<string | null>(null);
  const actor = actorContextForRole('hiring-manager');
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
    <div data-tour="role-view" className="p-8 max-w-5xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Hiring Manager Portal</h1>
        <p className="text-gray-500">
          Prepare from the persisted role template and submit validated scorecards.
        </p>
      </div>
      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      {selectedProfile && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Candidate profile for ${selectedProfile.name}`}
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
        >
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto shadow-2xl p-6">
            <div className="flex justify-between items-start mb-5">
              <div>
                <h2 className="text-xl font-bold">{selectedProfile.name}</h2>
                <p className="text-sm text-gray-500">{selectedProfile.email}</p>
              </div>
              <button
                type="button"
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

      <section aria-label="Interview feedback">
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
                className="bg-white border rounded-xl p-5 shadow-sm"
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

  return (
    <div className="flex h-screen w-full bg-gray-50 overflow-hidden font-sans">
      <Navigation onStartTour={() => setTourOpen(true)} />
      <main data-tour="main-workflow" className="flex-1 h-full overflow-y-auto tour-main-content">
        {bootError && <div className="m-6 p-3 bg-red-50 border border-red-200 text-red-700 rounded">{bootError}</div>}
        {currentRole === 'recruiter' && <RecruiterView />}
        {currentRole === 'candidate' && <CandidateView />}
        {currentRole === 'hiring-manager' && <HiringManagerView />}
        {currentRole === 'documentation' && <DocumentationView />}
      </main>
      <LiveActivityFeed />
      <AppTour
        open={tourOpen}
        includeDocumentation={currentRole === 'documentation'}
        onClose={() => setTourOpen(false)}
      />
    </div>
  );
}