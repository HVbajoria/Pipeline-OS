import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { ActorContext, ApprovalCardSummary } from '../shared/models';
import { ForbiddenError, PipelineError } from '../shared/errors';
import {
  actorContextForRole,
  type AppRole,
  type HumanRole
} from '../client/actorContext';
import {
  operationClient,
  type OperationClient
} from '../client/operationClient';
import { useStore } from '../lib/store';
import {
  projectApprovalCards,
  type ApprovalCardUiState,
  type ApprovalCardViewModel
} from '../lib/viewModels';

export type ApprovalCardAction = 'approve' | 'reject' | 'commit';

export interface ApprovalCardOperationClient {
  invoke: OperationClient['invoke'];
}

export interface ApprovalCardsPanelProps {
  /** Optional injection keeps the UI boundary easy to exercise without a second operation path. */
  client?: ApprovalCardOperationClient;
  /** The active human role is resolved from the shell when this is omitted. */
  role?: HumanRole;
  /** Tests/embedding hosts may provide the exact actor boundary explicitly. */
  actor?: ActorContext;
}

const ACTION_OPERATION_NAMES = {
  approve: 'approve_operation_plan',
  reject: 'reject_operation_plan',
  commit: 'commit_operation_plan'
} as const;

function actionLabel(action: ApprovalCardAction): string {
  if (action === 'approve') return 'Approve plan';
  if (action === 'reject') return 'Reject plan';
  return 'Commit approved plan';
}

/**
 * Route every human card button through the canonical OperationClient. This
 * function intentionally has no Zustand/repository access and refuses agent
 * actors before a protected operation can be attempted from the UI.
 */
export function invokeApprovalCardAction(
  client: ApprovalCardOperationClient,
  action: ApprovalCardAction,
  approvalId: string,
  actor: ActorContext
): Promise<unknown> {
  if (actor.actorType !== 'human_ui') {
    return Promise.reject(
      new ForbiddenError('Only a trusted human may change an approval card', {
        reason: 'approval_principal_required'
      })
    );
  }

  if (action === 'approve') {
    return client.invoke(
      ACTION_OPERATION_NAMES.approve,
      { approvalId },
      { actor }
    );
  }
  if (action === 'reject') {
    return client.invoke(
      ACTION_OPERATION_NAMES.reject,
      { approvalId },
      { actor }
    );
  }
  return client.invoke(
    ACTION_OPERATION_NAMES.commit,
    { approvalId },
    { actor }
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '{}';
}

function errorText(error: unknown): string {
  return PipelineError.from(error).message;
}

function statusClasses(state: ApprovalCardUiState): string {
  switch (state) {
    case 'pending':
      return 'bg-amber-100 text-amber-800';
    case 'approved':
      return 'bg-blue-100 text-blue-800';
    case 'committed':
      return 'bg-green-100 text-green-800';
    case 'rejected':
      return 'bg-gray-200 text-gray-700';
    case 'expired':
      return 'bg-red-100 text-red-800';
    case 'stale':
      return 'bg-orange-100 text-orange-800';
    case 'replayed':
      return 'bg-purple-100 text-purple-800';
  }
}

function statusDescription(view: ApprovalCardViewModel): string {
  switch (view.state) {
    case 'pending':
      return 'Waiting for a trusted human decision.';
    case 'approved':
      return 'Approved, but the target mutation has not been committed.';
    case 'committed':
      return 'Committed once; this card is single-use.';
    case 'rejected':
      return 'Rejected; the target mutation was not applied.';
    case 'expired':
      return 'Expired; re-plan before attempting the target mutation.';
    case 'stale':
      return 'The target or revision changed; re-plan before committing.';
    case 'replayed':
      return 'A replayed result is shown; it is not a second business mutation.';
  }
}

function roleForPanel(currentRole: AppRole, configuredRole?: HumanRole): HumanRole {
  if (configuredRole !== undefined) return configuredRole;
  return currentRole === 'documentation' ? 'recruiter' : currentRole;
}

function ImpactList({ card }: { card: ApprovalCardSummary }) {
  return (
    <section data-approval-impact aria-label="Exact target impact" className="space-y-2">
      <h4 className="font-medium text-gray-900">Exact target impact</h4>
      {card.affectedRecords.length > 0 ? (
        <ul className="space-y-1 text-sm text-gray-700">
          {card.affectedRecords.map((record, index) => (
            <li key={`${record.type}-${record.id}-${index}`} data-affected-record>
              <span className="font-medium">{record.effect}</span>{' '}
              <span>{record.type}</span>{' '}
              <code>{record.id}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No target records are affected.</p>
      )}
      {card.changeSummary.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-gray-700">
          {card.changeSummary.map((summary) => <li key={summary}>{summary}</li>)}
        </ul>
      )}
    </section>
  );
}

function MessageList({
  title,
  items,
  tone,
  testId
}: {
  title: string;
  items: readonly string[];
  tone: 'warning' | 'blocker';
  testId: string;
}) {
  if (items.length === 0) return null;
  const classes = tone === 'blocker'
    ? 'bg-red-50 border-red-200 text-red-800'
    : 'bg-amber-50 border-amber-200 text-amber-800';
  return (
    <section data-testid={testId} className={`rounded-lg border p-3 text-sm ${classes}`}>
      <h4 className="font-medium">{title}</h4>
      <ul className="list-disc pl-5 mt-1 space-y-1">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </section>
  );
}

function ApprovalCardView({
  view,
  actor,
  actionInFlight,
  actionError,
  actionNotice,
  onAction
}: {
  view: ApprovalCardViewModel;
  actor: ActorContext;
  actionInFlight: string | null;
  actionError?: string;
  actionNotice?: string;
  onAction: (action: ApprovalCardAction, card: ApprovalCardSummary) => void;
}) {
  const { card } = view;
  const humanActor = actor.actorType === 'human_ui';
  const actionEnabled = humanActor && view.state !== 'stale' && view.state !== 'replayed';
  const pendingAction = actionInFlight?.startsWith(`${card.id}:`) === true;
  const showApproveReject = view.state === 'pending' && actionEnabled;
  const showCommit = view.state === 'approved' && actionEnabled;

  return (
    <article
      id={`approval-card-${card.id}`}
      data-approval-card-id={card.id}
      data-approval-card-state={view.state}
      className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm space-y-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-900">{card.targetOperation}</h3>
          <p className="text-xs text-gray-500">Approval card {card.id}</p>
        </div>
        <span
          role="status"
          data-approval-status={view.state}
          className={`rounded-full px-2 py-1 text-xs font-medium capitalize ${statusClasses(view.state)}`}
        >
          {view.state}
        </span>
      </header>

      <p className="text-sm text-gray-700" data-approval-status-description>
        {statusDescription(view)}
      </p>

      {view.stale && (
        <p role="status" data-approval-stale className="rounded-lg bg-orange-50 border border-orange-200 p-3 text-sm text-orange-900">
          Stale conflict detected from the persisted Activity Feed. No automatic retry was attempted.
        </p>
      )}
      {view.replayed && (
        <p role="status" data-approval-replayed className="rounded-lg bg-purple-50 border border-purple-200 p-3 text-sm text-purple-900">
          Replayed result detected. This is an audit replay, not a second target mutation.
        </p>
      )}

      <ImpactList card={card} />

      <section data-approval-redacted-plan aria-label="Safe redacted plan details" className="space-y-2">
        <h4 className="font-medium text-gray-900">Safe redacted plan details</h4>
        <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-x-auto text-xs whitespace-pre-wrap">
          {json(card.proposedOutput)}
        </pre>
        {card.redactions && card.redactions.length > 0 && (
          <p className="text-xs text-gray-500">
            Redacted fields: {card.redactions.join(', ')}
          </p>
        )}
      </section>

      <MessageList
        title="Warnings"
        items={card.warnings}
        tone="warning"
        testId={`approval-warnings-${card.id}`}
      />
      <MessageList
        title="Blockers"
        items={card.blockers ?? []}
        tone="blocker"
        testId={`approval-blockers-${card.id}`}
      />

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-gray-600 border-t pt-3">
        <div><dt className="font-semibold inline">requested by</dt><dd className="inline"> {card.requestedBy.actorType} · {card.requestedBy.actorId}</dd></div>
        <div><dt className="font-semibold inline">requested at</dt><dd className="inline"> {formatTimestamp(card.requestedAt)}</dd></div>
        <div><dt className="font-semibold inline">base revision</dt><dd className="inline"> {card.baseRevision}</dd></div>
        <div><dt className="font-semibold inline">expires</dt><dd className="inline"> {formatTimestamp(card.expiresAt)}</dd></div>
        <div><dt className="font-semibold inline">required approval</dt><dd className="inline"> {card.approvalPolicy}</dd></div>
        <div><dt className="font-semibold inline">required capability</dt><dd className="inline"> {card.requiredCapability}</dd></div>
        {card.policyVersion && <div><dt className="font-semibold inline">policy version</dt><dd className="inline"> {card.policyVersion}</dd></div>}
        <div><dt className="font-semibold inline">correlation</dt><dd className="inline"> {card.correlationId}</dd></div>
        <div><dt className="font-semibold inline">trace</dt><dd className="inline"> {card.traceId}</dd></div>
      </dl>

      {card.approvalNote && <p className="text-sm text-blue-800">Approval note: {card.approvalNote}</p>}
      {card.rejectionNote && <p className="text-sm text-gray-700">Rejection note: {card.rejectionNote}</p>}

      {!humanActor && (
        <p role="alert" data-approval-agent-protection className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">
          Approval actions require a trusted human actor. This agent context cannot approve, reject, or commit a plan.
        </p>
      )}
      {actionError && (
        <p role="alert" data-approval-action-error className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {actionError}
        </p>
      )}
      {actionNotice && (
        <p role="status" data-approval-action-result className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-800">
          {actionNotice}
        </p>
      )}

      {(showApproveReject || showCommit) && (
        <div className="flex flex-wrap gap-2 border-t pt-3">
          {showApproveReject && (
            <>
              <button
                type="button"
                data-approval-action="approve"
                disabled={pendingAction}
                onClick={() => onAction('approve', card)}
                className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {pendingAction ? 'Working…' : actionLabel('approve')}
              </button>
              <button
                type="button"
                data-approval-action="reject"
                disabled={pendingAction}
                onClick={() => onAction('reject', card)}
                className="rounded border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
              >
                {actionLabel('reject')}
              </button>
            </>
          )}
          {showCommit && (
            <button
              type="button"
              data-approval-action="commit"
              disabled={pendingAction}
              onClick={() => onAction('commit', card)}
              className="rounded bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {pendingAction ? 'Working…' : actionLabel('commit')}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/** Human-facing projection of the actor-scoped approval-card queue. */
export function ApprovalCardsPanel({
  client = operationClient,
  role,
  actor: configuredActor
}: ApprovalCardsPanelProps) {
  const currentRole = useStore((state) => state.currentRole);
  const cards = useStore((state) => state.approvalCards);
  const activityLog = useStore((state) => state.activityLog);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [actionNotices, setActionNotices] = useState<Record<string, string>>({});
  const actor = configuredActor ?? actorContextForRole(roleForPanel(currentRole, role));
  const views = useMemo(
    () => projectApprovalCards(cards, activityLog),
    [cards, activityLog]
  );

  const handleAction = async (action: ApprovalCardAction, card: ApprovalCardSummary) => {
    const key = `${card.id}:${action}`;
    setActionInFlight(key);
    setActionErrors((previous) => {
      const next = { ...previous };
      delete next[card.id];
      return next;
    });
    deleteActionNotice(setActionNotices, card.id);
    try {
      await invokeApprovalCardAction(client, action, card.id, actor);
      setActionNotices((previous) => ({
        ...previous,
        [card.id]: `${actionLabel(action)} submitted. Shared state and the Activity Feed were refreshed by OperationClient.`
      }));
    } catch (error) {
      setActionErrors((previous) => ({ ...previous, [card.id]: errorText(error) }));
    } finally {
      setActionInFlight(null);
    }
  };

  return (
    <section data-approval-cards aria-label="Human approval cards" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Human approval cards</h2>
        <p className="text-sm text-gray-500">
          Review the exact redacted target impact before approving or committing an agent-created plan.
        </p>
      </div>
      {views.length === 0 ? (
        <p data-approval-cards-empty className="rounded-lg border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-500">
          No approval cards are visible for this actor.
        </p>
      ) : (
        <div className="space-y-4">
          {views.map((view) => (
            <ApprovalCardView
              key={view.card.id}
              view={view}
              actor={actor}
              actionInFlight={actionInFlight}
              actionError={actionErrors[view.card.id]}
              actionNotice={actionNotices[view.card.id]}
              onAction={(action, card) => void handleAction(action, card)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function deleteActionNotice(
  setter: Dispatch<SetStateAction<Record<string, string>>>,
  cardId: string
): void {
  setter((previous) => {
    if (!(cardId in previous)) return previous;
    const next = { ...previous };
    delete next[cardId];
    return next;
  });
}

export default ApprovalCardsPanel;
