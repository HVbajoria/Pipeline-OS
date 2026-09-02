import { ConflictError, ForbiddenError, ValidationError } from '../../shared/errors';
import type {
  CandidateId,
  CandidateRecord,
  SharedStateWithCatalogs,
  SourcedProspectId,
  Timestamp
} from '../../shared/models';
import type {
  CandidateSubmittedProfile,
  GitHubProspectAttribution,
  PublicProspectConsent,
  PublicProspectFieldOrigin,
  PublicProspectSourceReference,
  SourcedProspectRecord
} from '../../shared/publicProspects';
import type {
  ImportPublicProspectInput,
  ImportPublicProspectOutput
} from '../../shared/operations';
import {
  assertPublicProspectConsentUsable,
  evaluatePublicProspectConsent,
  normalizePublicProspectConsent,
  normalizePublicProspectFieldOrigins,
  normalizePublicProspectSourceReference,
  normalizePublicProspectTimestamp
} from '../../shared/domain/provenance';
import {
  assertArray,
  assertNonEmptyString,
  assertNumberInRange,
  assertPlainObject
} from '../../shared/validators';
import { deepClone } from '../repository';
import type {
  OperationHandler,
  OperationHandlerContext
} from '../operationService';

/** The deterministic retention period applied to a newly imported prospect. */
export const PUBLIC_PROSPECT_RETENTION_DAYS = 30;
export const PUBLIC_PROSPECT_RETENTION_MILLISECONDS =
  PUBLIC_PROSPECT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Safe, stable wording retained in a revocation result and audit output. */
export const PUBLIC_PROSPECT_WITHDRAWAL_RETENTION_ACTION =
  'Consent withdrawn; future public-prospect use is blocked and the safe provenance audit marker is retained.';

const SOURCE_ORIGIN: PublicProspectFieldOrigin = 'github_public';
const CANDIDATE_ORIGIN: PublicProspectFieldOrigin = 'candidate_submitted';
const SERVER_ORIGIN: PublicProspectFieldOrigin = 'recruiter_entered';

function candidateText(
  value: unknown,
  field: string,
  maximum: number
): string {
  const text = assertNonEmptyString(value, field).normalize('NFKC').trim();
  if (/[\u0000-\u001F\u007F]/u.test(text)) {
    throw new ValidationError(`${field} contains unsupported control characters`, {
      field
    });
  }
  if (text.length > maximum) {
    throw new ValidationError(`${field} must be at most ${maximum} characters`, {
      field
    });
  }
  return text;
}

function normalizeCandidateProfile(
  value: CandidateSubmittedProfile
): CandidateSubmittedProfile {
  const profile = assertPlainObject(value, 'candidateProfile');
  const skills =
    profile.skills === undefined
      ? undefined
      : assertArray<unknown>(profile.skills, 'candidateProfile.skills').map(
          (skill, index) => candidateText(skill, `candidateProfile.skills[${index}]`, 80)
        );

  return {
    name: candidateText(profile.name, 'candidateProfile.name', 160),
    email: candidateText(profile.email, 'candidateProfile.email', 320),
    resumeText: candidateText(profile.resumeText, 'candidateProfile.resumeText', 10000),
    ...(skills === undefined ? {} : { skills }),
    ...(profile.experienceYears === undefined
      ? {}
      : {
          experienceYears: assertNumberInRange(
            profile.experienceYears,
            0,
            100,
            'candidateProfile.experienceYears'
          )
        })
  };
}

function assertCandidateProfileConsent(
  consent: PublicProspectConsent,
  candidateProfile: CandidateSubmittedProfile | undefined
): void {
  if (candidateProfile === undefined || consent.method === 'candidate_submitted') {
    return;
  }

  throw new ValidationError(
    'Candidate profile fields require candidate-submitted consent',
    {
      field: 'candidateProfile',
      reason: 'consent_invalid'
    }
  );
}

function sourceReferenceFromInput(
  input: ImportPublicProspectInput
): PublicProspectSourceReference {
  return normalizePublicProspectSourceReference({
    source: input.source,
    sourceRecordId: input.sourceRecordId,
    profileUrl: input.profileUrl,
    canonicalSourceUrl: input.canonicalSourceUrl,
    sourceQuery: input.sourceQuery,
    ...(input.sourceFilters === undefined
      ? {}
      : { sourceFilters: input.sourceFilters }),
    fetchedAt: input.fetchedAt,
    attribution: input.attribution
  });
}

function sourceFingerprint(source: PublicProspectSourceReference): string {
  return JSON.stringify({
    source: source.source,
    sourceRecordId: source.sourceRecordId,
    profileUrl: source.profileUrl,
    canonicalSourceUrl: source.canonicalSourceUrl,
    sourceQuery: source.sourceQuery,
    sourceFilters: source.sourceFilters ?? null,
    fetchedAt: source.fetchedAt,
    attribution: source.attribution
  });
}

function consentFingerprint(consent: PublicProspectConsent): string {
  return JSON.stringify({
    method: consent.method,
    scope: consent.scope,
    capturedAt: consent.capturedAt,
    capturedBy: consent.capturedBy,
    evidenceRef: consent.evidenceRef,
    policyVersion: consent.policyVersion
  });
}

function nextAvailableId(
  context: OperationHandlerContext,
  collection: Map<string, unknown>,
  prefix: string
): string {
  let id = context.nextId(prefix);
  while (collection.has(id)) id = context.nextId(prefix);
  return id;
}

function retentionExpiry(now: Timestamp): Timestamp {
  const parsed = Date.parse(now);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError('The operation clock returned an invalid timestamp', {
      field: 'now'
    });
  }
  return new Date(parsed + PUBLIC_PROSPECT_RETENTION_MILLISECONDS).toISOString();
}

function fieldOrigins(
  source: PublicProspectSourceReference,
  consent: PublicProspectConsent,
  candidateProfile: CandidateSubmittedProfile | undefined,
  candidateId: CandidateId | undefined
): Record<string, PublicProspectFieldOrigin> {
  const origins: Record<string, PublicProspectFieldOrigin> = {
    source: SOURCE_ORIGIN,
    sourceRecordId: SOURCE_ORIGIN,
    profileUrl: SOURCE_ORIGIN,
    canonicalSourceUrl: SOURCE_ORIGIN,
    sourceQuery: SOURCE_ORIGIN,
    fetchedAt: SOURCE_ORIGIN,
    dataOrigin: SOURCE_ORIGIN,
    attribution: SOURCE_ORIGIN,
    consentStatus:
      consent.method === 'candidate_submitted' ? CANDIDATE_ORIGIN : SERVER_ORIGIN,
    consent:
      consent.method === 'candidate_submitted' ? CANDIDATE_ORIGIN : SERVER_ORIGIN,
    importedAt: SERVER_ORIGIN,
    retentionExpiresAt: SERVER_ORIGIN
  };
  if (source.sourceFilters !== undefined) origins.sourceFilters = SOURCE_ORIGIN;
  if (candidateProfile !== undefined) {
    origins.name = CANDIDATE_ORIGIN;
    origins.email = CANDIDATE_ORIGIN;
    origins.resumeText = CANDIDATE_ORIGIN;
    if (candidateProfile.skills !== undefined) origins.skills = CANDIDATE_ORIGIN;
    if (candidateProfile.experienceYears !== undefined) {
      origins.experienceYears = CANDIDATE_ORIGIN;
    }
  }
  if (candidateId !== undefined) origins.candidateId = CANDIDATE_ORIGIN;
  return normalizePublicProspectFieldOrigins(origins);
}

function sourceRecordForImport(
  state: SharedStateWithCatalogs,
  source: PublicProspectSourceReference,
  consent: PublicProspectConsent,
  now: Timestamp
): SourcedProspectRecord | undefined {
  const sameSourceRecords = [...state.sourcedProspects.values()].filter(
    (record) =>
      record.source === source.source && record.sourceRecordId === source.sourceRecordId
  );

  // Withdrawal is terminal for this public source identity. A changed
  // consent payload must not create a second record that bypasses the
  // withdrawn record's reuse block.
  const withdrawnRecord = sameSourceRecords.find(
    (record) => record.consentStatus === 'withdrawn'
  );
  if (withdrawnRecord !== undefined) {
    throw new ConflictError('Public prospect consent has already been withdrawn', {
      reason: 'already_withdrawn',
      recordType: 'Sourced_Prospect_Record',
      recordId: withdrawnRecord.id
    });
  }

  for (const record of sameSourceRecords) {
    if (sourceFingerprint(record) !== sourceFingerprint(source)) {
      throw new ConflictError(
        'The public prospect source reference changed and cannot be overwritten',
        {
          reason: 'entity_changed',
          recordType: 'Sourced_Prospect_Record',
          recordId: record.id
        }
      );
    }
  }

  const matchingConsent = sameSourceRecords.find(
    (record) =>
      record.consent !== null &&
      consentFingerprint(record.consent) === consentFingerprint(consent)
  );

  if (matchingConsent !== undefined) {
    assertPublicProspectConsentUsable(matchingConsent, {
      now,
      requiredScope: consent.scope,
      policyVersion: consent.policyVersion
    });
    return matchingConsent;
  }

  const activeRecord = sameSourceRecords.find(
    (record) => evaluatePublicProspectConsent(record, now).allowed
  );
  if (activeRecord !== undefined) {
    throw new ConflictError(
      'The public prospect already has an active import with different consent metadata',
      {
        reason: 'entity_changed',
        recordType: 'Sourced_Prospect_Record',
        recordId: activeRecord.id
      }
    );
  }

  // An expired record may be followed by a new, separately consented version.
  // The old record remains expired and is never revived.
  return undefined;
}

function candidateForProfile(
  context: OperationHandlerContext,
  profile: CandidateSubmittedProfile
): { candidate: CandidateRecord; created: boolean } {
  const normalizedEmail = profile.email.toLowerCase();
  const existing = [...context.state.candidates.values()].find(
    (candidate) => candidate.email.toLowerCase() === normalizedEmail
  );
  if (existing !== undefined) return { candidate: existing, created: false };

  const candidateId = nextAvailableId(
    context,
    context.state.candidates as Map<string, unknown>,
    'candidate'
  ) as CandidateId;
  const candidate: CandidateRecord = {
    id: candidateId,
    name: profile.name,
    email: profile.email,
    resumeText: profile.resumeText,
    skills: profile.skills === undefined ? [] : [...profile.skills],
    experienceYears: profile.experienceYears ?? 0,
    resumeTextHistory: []
  };
  context.state.candidates.set(candidateId, candidate);
  return { candidate, created: true };
}

function candidateIsLinkedElsewhere(
  state: SharedStateWithCatalogs,
  candidateId: CandidateId,
  excludedProspectId: SourcedProspectId
): boolean {
  return [...state.sourcedProspects.values()].some(
    (record) =>
      record.id !== excludedProspectId &&
      record.candidateId === candidateId &&
      record.consentStatus !== 'withdrawn' &&
      record.consentStatus !== 'expired'
  );
}

/**
 * Explicit retention hook for consent withdrawal/expiry. A candidate created
 * solely from submitted prospect fields is deleted when it has no application
 * and no other active sourced-prospect link. Preexisting candidates are only
 * unlinked, because their independent recruiting record must remain intact.
 */
export function applyPublicProspectLinkedCandidateRetention(
  state: SharedStateWithCatalogs,
  record: SourcedProspectRecord
): { candidateId?: CandidateId; action: 'deleted' | 'unlinked' | 'none' } {
  const candidateId = record.candidateId;
  if (candidateId === undefined) return { action: 'none' };

  record.candidateId = undefined;
  const linkOrigin = record.candidateLinkOrigin;
  record.candidateLinkOrigin = undefined;
  const shouldDelete =
    linkOrigin === 'created_from_candidate_submitted' &&
    !candidateIsLinkedElsewhere(state, candidateId, record.id) &&
    ![...state.applications.values()].some(
      (application) => application.candidateId === candidateId
    );
  if (shouldDelete) {
    state.candidates.delete(candidateId);
    return { candidateId, action: 'deleted' };
  }
  return { candidateId, action: 'unlinked' };
}

/**
 * Explicit, host-callable retention cleanup. It terminalizes records whose
 * retention window has elapsed and applies the linked-candidate hook above.
 * Safe public provenance remains so the audit meaning is not erased.
 */
export function applyPublicProspectRetention(
  state: SharedStateWithCatalogs,
  now: Timestamp
): { expiredProspectIds: SourcedProspectId[]; deletedCandidateIds: CandidateId[] } {
  const normalizedNow = normalizePublicProspectTimestamp(now, 'now');
  const nowMillis = Date.parse(normalizedNow);
  const expiredProspectIds: SourcedProspectId[] = [];
  const deletedCandidateIds: CandidateId[] = [];

  for (const record of state.sourcedProspects.values()) {
    if (
      record.consentStatus === 'withdrawn' ||
      record.consentStatus === 'expired' ||
      !Number.isFinite(Date.parse(record.retentionExpiresAt)) ||
      Date.parse(record.retentionExpiresAt) > nowMillis
    ) {
      continue;
    }
    record.consentStatus = 'expired';
    record.expiredAt ??= normalizedNow;
    const retention = applyPublicProspectLinkedCandidateRetention(state, record);
    if (retention.candidateId !== undefined && retention.action === 'deleted') {
      deletedCandidateIds.push(retention.candidateId);
    }
    expiredProspectIds.push(record.id);
  }

  return { expiredProspectIds, deletedCandidateIds };
}

function createSourcedProspect(
  context: OperationHandlerContext,
  source: PublicProspectSourceReference,
  consent: PublicProspectConsent,
  candidateProfile: CandidateSubmittedProfile | undefined,
  candidateId: CandidateId | undefined,
  candidateCreated: boolean,
  importedAt: Timestamp,
  retentionExpiresAt: Timestamp
): SourcedProspectRecord {
  const id = nextAvailableId(
    context,
    context.state.sourcedProspects as Map<string, unknown>,
    'prospect'
  ) as SourcedProspectId;
  return {
    id,
    ...deepClone(source),
    importedAt,
    dataOrigin: 'public_github',
    consentStatus: 'explicit',
    consent: deepClone(consent),
    fieldOrigins: fieldOrigins(source, consent, candidateProfile, candidateId),
    attribution: deepClone(source.attribution) as GitHubProspectAttribution,
    retentionExpiresAt,
    ...(candidateId === undefined
      ? {}
      : {
          candidateId,
          candidateLinkOrigin: candidateCreated
            ? 'created_from_candidate_submitted' as const
            : 'preexisting_candidate' as const
        })
  };
}

function attachCandidateOrigin(
  record: SourcedProspectRecord,
  source: PublicProspectSourceReference,
  consent: PublicProspectConsent,
  profile: CandidateSubmittedProfile,
  candidateId: CandidateId,
  candidateCreated: boolean
): void {
  record.fieldOrigins = fieldOrigins(
    source,
    consent,
    profile,
    candidateId
  );
  record.candidateId = candidateId;
  record.candidateLinkOrigin = candidateCreated
    ? 'created_from_candidate_submitted'
    : 'preexisting_candidate';
}

/**
 * Import a validated public GitHub source reference only after explicit
 * consent. Public source facts stay in SourcedProspectRecord; candidate
 * contact/resume values can enter CandidateRecord only through candidateProfile.
 */
export const importPublicProspect: OperationHandler<'import_public_prospect'> = (
  input,
  context
): ImportPublicProspectOutput => {
  // Agents may prepare a redacted preview, but only a trusted human commit
  // (or a legacy human call when no policy is configured) may persist it.
  if (context.actor.actorType === 'agent' && !context.preview) {
    throw new ForbiddenError('Only a trusted human may import a public prospect', {
      reason: 'approval_principal_required'
    });
  }

  const source = sourceReferenceFromInput(input);
  const consent = normalizePublicProspectConsent(input.consent);
  if (consent.capturedBy.actorType !== 'human_ui') {
    throw new ValidationError('Consent must be captured by a human actor', {
      field: 'consent.capturedBy',
      reason: 'consent_invalid'
    });
  }
  assertCandidateProfileConsent(consent, input.candidateProfile);
  const candidateProfile =
    input.candidateProfile === undefined
      ? undefined
      : normalizeCandidateProfile(input.candidateProfile);
  const importedAt = normalizePublicProspectTimestamp(context.now(), 'now');
  applyPublicProspectRetention(context.state, importedAt);
  const retentionExpiresAt = retentionExpiry(importedAt);

  const prospectiveRecord = {
    consentStatus: 'explicit' as const,
    consent,
    retentionExpiresAt
  };
  assertPublicProspectConsentUsable(prospectiveRecord, {
    now: importedAt,
    requiredScope: consent.scope,
    policyVersion: consent.policyVersion
  });

  const existing = sourceRecordForImport(
    context.state,
    source,
    consent,
    importedAt
  );
  if (existing !== undefined) {
    if (candidateProfile !== undefined && existing.candidateId === undefined) {
      const linked = candidateForProfile(context, candidateProfile);
      attachCandidateOrigin(
        existing,
        source,
        consent,
        candidateProfile,
        linked.candidate.id,
        linked.created
      );
      return {
        sourcedProspect: deepClone(existing),
        candidateId: linked.candidate.id,
        status: 'linked'
      };
    }
    return {
      sourcedProspect: deepClone(existing),
      ...(existing.candidateId === undefined ? {} : { candidateId: existing.candidateId }),
      status: existing.candidateId === undefined ? 'imported' : 'linked'
    };
  }

  const linked =
    candidateProfile === undefined
      ? undefined
      : candidateForProfile(context, candidateProfile);
  const record = createSourcedProspect(
    context,
    source,
    consent,
    candidateProfile,
    linked?.candidate.id,
    linked?.created ?? false,
    importedAt,
    retentionExpiresAt
  );
  context.state.sourcedProspects.set(record.id, record);

  return {
    sourcedProspect: deepClone(record),
    ...(linked === undefined ? {} : { candidateId: linked.candidate.id }),
    status: linked === undefined ? 'imported' : 'linked'
  };
};

/** Find the stable withdrawal timestamp from the safe audit fact, if present. */
export function priorWithdrawalTimestamp(
  state: SharedStateWithCatalogs,
  sourcedProspectId: string
): Timestamp | undefined {
  const record = state.sourcedProspects.get(sourcedProspectId);
  if (record?.withdrawnAt !== undefined) {
    return normalizePublicProspectTimestamp(record.withdrawnAt, 'withdrawnAt');
  }
  for (let index = state.activityLog.length - 1; index >= 0; index -= 1) {
    const entry = state.activityLog[index];
    if (entry.toolName !== 'revoke_public_prospect_consent') continue;
    const output = entry.output as Record<string, unknown>;
    if (
      output.sourcedProspectId !== sourcedProspectId ||
      output.status !== 'withdrawn' ||
      typeof output.withdrawnAt !== 'string'
    ) {
      continue;
    }
    return normalizePublicProspectTimestamp(output.withdrawnAt, 'withdrawnAt');
  }
  return undefined;
}

export const importPublicProspectHandler = importPublicProspect;
export default importPublicProspect;
