import { z } from 'zod';

export const LifecycleStatusSchema = z.enum([
  'proposed',
  'confirmed',
  'superseded',
  'retracted',
  'expired',
]);
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

export const ScopeSchema = z.object({
  namespace: z.string().trim().min(1),
  appliesTo: z.string().trim().min(1),
});
export type Scope = z.infer<typeof ScopeSchema>;

export const ClaimSchema = z.object({
  scope: ScopeSchema,
  subject: z.string().trim().min(1),
  predicate: z.string().trim().min(1),
  value: z.string().trim().min(1),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const SourceAuthorityKindSchema = z.enum([
  'customer-contract',
  'approved-policy',
  'system-of-record',
  'human-attestation',
  'unclassified',
]);
export type SourceAuthorityKind = z.infer<typeof SourceAuthorityKindSchema>;

export const SourceAuthoritySchema = z.object({
  kind: SourceAuthorityKindSchema,
  authorityRef: z.string().trim().min(1),
  independenceKey: z.string().trim().min(1),
});
export type SourceAuthority = z.infer<typeof SourceAuthoritySchema>;

export const ActorSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum(['human', 'system', 'integration']),
  authorityRef: z.string().trim().min(1).optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const EvidenceSchema = z.object({
  id: z.string().trim().min(1),
  sourceRef: z.string().trim().min(1),
  scope: ScopeSchema,
  authority: SourceAuthoritySchema,
  capturedAt: z.string().datetime(),
  recordedBy: ActorSchema,
  summary: z.string().trim().min(1).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ReviewSchema = z.object({
  id: z.string().trim().min(1),
  reviewer: ActorSchema.refine((actor) => actor.kind === 'human', {
    message: 'Reviews must be recorded by a human actor.',
  }),
  decision: z.enum(['accepted', 'rejected']),
  reviewedAt: z.string().datetime(),
  reason: z.string().trim().min(1),
});
export type Review = z.infer<typeof ReviewSchema>;

export const LifecycleEventSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum([
    'proposed',
    'evidence_added',
    'review_recorded',
    'confirmed',
    'superseded',
    'retracted',
    'expired',
  ]),
  occurredAt: z.string().datetime(),
  actor: ActorSchema,
  reason: z.string().trim().min(1),
});
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

export function scopeKey(scopeInput: z.input<typeof ScopeSchema>): string {
  const scope = ScopeSchema.parse(scopeInput);
  return `${normalize(scope.namespace)}::${normalize(scope.appliesTo)}`;
}

export function canonicalizeClaim(claimInput: z.input<typeof ClaimSchema>): string {
  const claim = ClaimSchema.parse(claimInput);
  return [
    scopeKey(claim.scope),
    normalize(claim.subject),
    normalize(claim.predicate),
    normalize(claim.value),
  ].join('::');
}

const MemoryRecordBaseSchema = z.object({
  id: z.string().trim().min(1),
  claim: ClaimSchema,
  canonicalClaim: z.string().trim().min(1),
  status: LifecycleStatusSchema,
  evidence: z.array(EvidenceSchema),
  reviews: z.array(ReviewSchema),
  events: z.array(LifecycleEventSchema).min(1),
  createdAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  supersededBy: z.string().trim().min(1).optional(),
  retractionReason: z.string().trim().min(1).optional(),
});

export const MemoryRecordSchema = MemoryRecordBaseSchema.superRefine((record, context) => {
  if (record.canonicalClaim !== canonicalizeClaim(record.claim)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'canonicalClaim must match the normalized claim.',
      path: ['canonicalClaim'],
    });
  }

  if (record.events[0]?.type !== 'proposed' || record.events[0]?.occurredAt !== record.createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'The first event must be the proposal at createdAt.',
      path: ['events'],
    });
  }

  const eventIds = new Set<string>();
  let priorTimestamp = -Infinity;
  for (const [index, event] of record.events.entries()) {
    if (eventIds.has(event.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Lifecycle event IDs must be unique.',
        path: ['events', index, 'id'],
      });
    }
    eventIds.add(event.id);

    const timestamp = Date.parse(event.occurredAt);
    if (timestamp < priorTimestamp) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Lifecycle events must be ordered by occurredAt.',
        path: ['events', index, 'occurredAt'],
      });
    }
    priorTimestamp = timestamp;
  }

  const evidenceIds = new Set<string>();
  const sourceRefs = new Set<string>();
  for (const [index, evidence] of record.evidence.entries()) {
    if (evidenceIds.has(evidence.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Evidence IDs must be unique.',
        path: ['evidence', index, 'id'],
      });
    }
    evidenceIds.add(evidence.id);

    const sourceRef = normalize(evidence.sourceRef);
    if (sourceRefs.has(sourceRef)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Evidence source references must be unique after normalization.',
        path: ['evidence', index, 'sourceRef'],
      });
    }
    sourceRefs.add(sourceRef);

    if (scopeKey(evidence.scope) !== scopeKey(record.claim.scope)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Evidence scope must match the memory claim scope.',
        path: ['evidence', index, 'scope'],
      });
    }
  }

  const reviewIds = new Set<string>();
  let priorReviewTimestamp = -Infinity;
  for (const [index, review] of record.reviews.entries()) {
    if (reviewIds.has(review.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Review IDs must be unique.',
        path: ['reviews', index, 'id'],
      });
    }
    reviewIds.add(review.id);

    const timestamp = Date.parse(review.reviewedAt);
    if (timestamp <= priorReviewTimestamp) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Reviews must be strictly ordered by reviewedAt.',
        path: ['reviews', index, 'reviewedAt'],
      });
    }
    priorReviewTimestamp = timestamp;
  }

  if (record.lastActivityAt !== record.events.at(-1)?.occurredAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'lastActivityAt must equal the most recent lifecycle event time.',
      path: ['lastActivityAt'],
    });
  }

  const eventTypes = new Set(record.events.map((event) => event.type));
  const terminalEvents = record.events.filter((event) =>
    ['superseded', 'retracted', 'expired'].includes(event.type),
  );
  if (terminalEvents.length > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A memory may have only one terminal lifecycle event.',
      path: ['events'],
    });
  }
  if (terminalEvents.length === 1 && record.events.at(-1)?.id !== terminalEvents[0]?.id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A terminal lifecycle event must be the final event.',
      path: ['events'],
    });
  }
  const terminalStateRules: Partial<Record<LifecycleStatus, { event: LifecycleEvent['type']; field?: keyof typeof record }>> = {
    confirmed: { event: 'confirmed' },
    superseded: { event: 'superseded', field: 'supersededBy' },
    retracted: { event: 'retracted', field: 'retractionReason' },
    expired: { event: 'expired' },
  };
  const terminalRule = terminalStateRules[record.status];
  if (terminalRule && !eventTypes.has(terminalRule.event)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${record.status} records require a ${terminalRule.event} event.`,
      path: ['events'],
    });
  }
  if (terminalRule?.field && !record[terminalRule.field]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${record.status} records require ${terminalRule.field}.`,
      path: [terminalRule.field],
    });
  }

  if (record.status === 'proposed' && (eventTypes.has('confirmed') || terminalEvents.length > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Proposed records cannot contain confirmation or terminal events.',
      path: ['status'],
    });
  }
  if (record.status === 'confirmed' && !eventTypes.has('confirmed')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Confirmed records require a confirmed event.',
      path: ['events'],
    });
  }
  if (record.status === 'confirmed' && terminalEvents.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Confirmed records cannot contain terminal events.',
      path: ['status'],
    });
  }
  if (record.status === 'superseded' && !eventTypes.has('confirmed')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Superseded records require a prior confirmed event.',
      path: ['events'],
    });
  }
  if (record.status === 'expired' && eventTypes.has('confirmed')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expired records cannot contain a confirmed event.',
      path: ['events'],
    });
  }
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const LifecyclePolicySchema = z.object({
  requiredIndependentSources: z.number().int().min(2).default(2),
  qualifyingAuthorityKinds: z
    .array(SourceAuthorityKindSchema)
    .min(1)
    .refine((kinds) => new Set(kinds).size === kinds.length, {
      message: 'qualifyingAuthorityKinds must not contain duplicates.',
    })
    .default([
      'customer-contract',
      'approved-policy',
      'system-of-record',
      'human-attestation',
    ]),
  proposedTtlDays: z.number().int().min(1).default(30),
});
export type LifecyclePolicy = z.infer<typeof LifecyclePolicySchema>;

export const LifecycleDecisionSchema = z.object({
  currentStatus: LifecycleStatusSchema,
  nextStatus: LifecycleStatusSchema,
  transition: z.enum(['confirmed', 'expired']).nullable(),
  reason: z.string().trim().min(1),
  basis: z.object({
    qualifiedIndependentSources: z.number().int().min(0),
    requiredIndependentSources: z.number().int().min(2),
    latestReview: z.enum(['accepted', 'rejected']).nullable(),
  }),
});
export type LifecycleDecision = z.infer<typeof LifecycleDecisionSchema>;

export const ExplicitActionSchema = z.object({
  actor: ActorSchema.refine((actor) => actor.kind === 'human', {
    message: 'Supersession and retraction require a human actor.',
  }),
  reason: z.string().trim().min(1),
});
export type ExplicitAction = z.infer<typeof ExplicitActionSchema>;

export const DEFAULT_POLICY: LifecyclePolicy = {
  requiredIndependentSources: 2,
  qualifyingAuthorityKinds: [
    'customer-contract',
    'approved-policy',
    'system-of-record',
    'human-attestation',
  ],
  proposedTtlDays: 30,
};

const ProposalInputSchema = z.object({
  id: z.string().trim().min(1),
  claim: ClaimSchema,
});

const POLICY_ACTOR: Actor = {
  id: 'memory-policy',
  kind: 'system',
};

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freezeDeep(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function parseRecord(value: unknown): MemoryRecord {
  return freezeDeep(MemoryRecordSchema.parse(value));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function createEvent(
  record: Pick<MemoryRecord, 'id' | 'events'>,
  type: LifecycleEvent['type'],
  occurredAt: string,
  actor: Actor,
  reason: string,
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    id: `${record.id}:${record.events.length + 1}:${type}`,
    type,
    occurredAt,
    actor,
    reason,
  });
}

function appendEvent(
  record: MemoryRecord,
  event: LifecycleEvent,
  changes: Partial<MemoryRecord> = {},
): MemoryRecord {
  if (Date.parse(event.occurredAt) < Date.parse(record.lastActivityAt)) {
    throw new Error('Lifecycle events cannot be recorded before the current activity time.');
  }

  return parseRecord({
    ...clone(record),
    ...changes,
    lastActivityAt: event.occurredAt,
    events: [...record.events, event],
  });
}

function transition(
  record: MemoryRecord,
  status: LifecycleStatus,
  event: LifecycleEvent,
  changes: Partial<MemoryRecord> = {},
): MemoryRecord {
  return appendEvent(record, event, { ...changes, status });
}

function assertProposed(record: MemoryRecord): void {
  if (record.status !== 'proposed') {
    throw new Error(`Only proposed memories can be updated. Current status: ${record.status}.`);
  }
}

function parsePolicy(policyInput: Partial<LifecyclePolicy>): LifecyclePolicy {
  return LifecyclePolicySchema.parse({ ...DEFAULT_POLICY, ...policyInput });
}

export function proposeMemory(
  input: z.input<typeof ProposalInputSchema>,
  now = new Date(),
): MemoryRecord {
  const proposal = ProposalInputSchema.parse(input);
  const timestamp = nowIso(now);
  const initialEvent = LifecycleEventSchema.parse({
    id: `${proposal.id}:1:proposed`,
    type: 'proposed',
    occurredAt: timestamp,
    actor: POLICY_ACTOR,
    reason: 'Claim entered the lifecycle as proposed.',
  });

  return parseRecord({
    id: proposal.id,
    claim: proposal.claim,
    canonicalClaim: canonicalizeClaim(proposal.claim),
    status: 'proposed',
    evidence: [],
    reviews: [],
    events: [initialEvent],
    createdAt: timestamp,
    lastActivityAt: timestamp,
  });
}

export function addEvidence(
  record: MemoryRecord,
  evidenceInput: z.input<typeof EvidenceSchema>,
  recordedAt = new Date(),
): MemoryRecord {
  const memory = parseRecord(record);
  const evidence = EvidenceSchema.parse(evidenceInput);
  const timestamp = nowIso(recordedAt);
  assertProposed(memory);

  if (memory.evidence.some((item) => item.id === evidence.id)) {
    throw new Error(`Evidence ID "${evidence.id}" already exists on this memory.`);
  }
  if (memory.evidence.some((item) => normalize(item.sourceRef) === normalize(evidence.sourceRef))) {
    throw new Error(`Evidence sourceRef "${evidence.sourceRef}" already exists on this memory.`);
  }
  if (scopeKey(evidence.scope) !== scopeKey(memory.claim.scope)) {
    throw new Error('Evidence scope must match the memory claim scope.');
  }
  if (Date.parse(evidence.capturedAt) > recordedAt.getTime()) {
    throw new Error('Evidence capturedAt cannot be later than the time it is recorded.');
  }

  return appendEvent(
    memory,
    createEvent(memory, 'evidence_added', timestamp, evidence.recordedBy, `Evidence recorded from ${evidence.sourceRef}.`),
    { evidence: [...memory.evidence, evidence] },
  );
}

export function recordReview(
  record: MemoryRecord,
  reviewInput: z.input<typeof ReviewSchema>,
  recordedAt = new Date(),
): MemoryRecord {
  const memory = parseRecord(record);
  const review = ReviewSchema.parse(reviewInput);
  const timestamp = nowIso(recordedAt);
  assertProposed(memory);

  if (memory.reviews.some((item) => item.id === review.id)) {
    throw new Error(`Review ID "${review.id}" already exists on this memory.`);
  }
  if (Date.parse(review.reviewedAt) > recordedAt.getTime()) {
    throw new Error('Review reviewedAt cannot be later than the time it is recorded.');
  }
  const latestReview = memory.reviews.at(-1);
  if (latestReview && Date.parse(review.reviewedAt) <= Date.parse(latestReview.reviewedAt)) {
    throw new Error('Review reviewedAt must be later than the latest recorded review.');
  }

  return appendEvent(
    memory,
    createEvent(
      memory,
      'review_recorded',
      timestamp,
      review.reviewer,
      `Review recorded from ${review.reviewer.id}: ${review.decision}.`,
    ),
    { reviews: [...memory.reviews, review] },
  );
}

export function independentSourceCount(
  record: MemoryRecord,
  policyInput: Partial<LifecyclePolicy> = {},
): number {
  const memory = parseRecord(record);
  const policy = parsePolicy(policyInput);
  return new Set(
    memory.evidence
      .filter((evidence) => policy.qualifyingAuthorityKinds.includes(evidence.authority.kind))
      .map((evidence) => normalize(evidence.authority.independenceKey)),
  ).size;
}

/** @deprecated Use independentSourceCount to make the policy criterion explicit. */
export const distinctSourceCount = independentSourceCount;

/**
 * Explains the policy outcome without mutating or transitioning the record.
 * Callers can inspect this result before persisting the record returned by
 * evaluateLifecycle.
 */
export function decideLifecycle(
  record: MemoryRecord,
  policyInput: Partial<LifecyclePolicy> = {},
  now = new Date(),
): LifecycleDecision {
  const memory = parseRecord(record);
  const policy = parsePolicy(policyInput);
  if (now.getTime() < Date.parse(memory.lastActivityAt)) {
    throw new Error('Evaluation time cannot precede the latest lifecycle activity.');
  }

  const sourceCount = independentSourceCount(memory, policy);
  const latestReview = memory.reviews.at(-1);
  const basis = {
    qualifiedIndependentSources: sourceCount,
    requiredIndependentSources: policy.requiredIndependentSources,
    latestReview: latestReview?.decision ?? null,
  };

  if (memory.status !== 'proposed') {
    return LifecycleDecisionSchema.parse({
      currentStatus: memory.status,
      nextStatus: memory.status,
      transition: null,
      reason: `No automatic transition is permitted for ${memory.status} memories.`,
      basis,
    });
  }

  if (latestReview?.decision === 'accepted') {
    return LifecycleDecisionSchema.parse({
      currentStatus: 'proposed',
      nextStatus: 'confirmed',
      transition: 'confirmed',
      reason: `Confirmed by accepted review from ${latestReview.reviewer.id}.`,
      basis,
    });
  }

  const lastActivity = new Date(memory.lastActivityAt).getTime();
  const ttlMilliseconds = policy.proposedTtlDays * 24 * 60 * 60 * 1000;
  if (now.getTime() - lastActivity >= ttlMilliseconds) {
    return LifecycleDecisionSchema.parse({
      currentStatus: 'proposed',
      nextStatus: 'expired',
      transition: 'expired',
      reason: `Proposed memory expired after ${policy.proposedTtlDays} inactive days.`,
      basis,
    });
  }

  if (latestReview?.decision === 'rejected') {
    return LifecycleDecisionSchema.parse({
      currentStatus: 'proposed',
      nextStatus: 'proposed',
      transition: null,
      reason: `Still proposed: latest review from ${latestReview.reviewer.id} was rejected and blocks automatic confirmation.`,
      basis,
    });
  }

  if (sourceCount >= policy.requiredIndependentSources) {
    return LifecycleDecisionSchema.parse({
      currentStatus: 'proposed',
      nextStatus: 'confirmed',
      transition: 'confirmed',
      reason: `Confirmed by ${sourceCount} independent qualified sources.`,
      basis,
    });
  }

  return LifecycleDecisionSchema.parse({
    currentStatus: 'proposed',
    nextStatus: 'proposed',
    transition: null,
    reason: `Still proposed: ${sourceCount} of ${policy.requiredIndependentSources} independent qualified sources and no accepted review.`,
    basis,
  });
}

export function evaluateLifecycle(
  record: MemoryRecord,
  policyInput: Partial<LifecyclePolicy> = {},
  now = new Date(),
): MemoryRecord {
  const memory = parseRecord(record);
  const decision = decideLifecycle(memory, policyInput, now);

  if (!decision.transition) {
    return parseRecord(memory);
  }

  return transition(
    memory,
    decision.nextStatus,
    createEvent(memory, decision.transition, nowIso(now), POLICY_ACTOR, decision.reason),
  );
}

export function supersedeMemory(
  record: MemoryRecord,
  replacementRecord: MemoryRecord,
  actionInput: z.input<typeof ExplicitActionSchema>,
  now = new Date(),
): MemoryRecord {
  const memory = parseRecord(record);
  const replacement = parseRecord(replacementRecord);
  const action = ExplicitActionSchema.parse(actionInput);

  if (memory.status !== 'confirmed') {
    throw new Error('Only confirmed memories can be superseded.');
  }
  if (replacement.status !== 'confirmed') {
    throw new Error('A replacement memory must already be confirmed.');
  }
  if (memory.id === replacement.id) {
    throw new Error('A memory cannot supersede itself.');
  }
  if (scopeKey(memory.claim.scope) !== scopeKey(replacement.claim.scope)) {
    throw new Error('A replacement memory must have the same scope as the memory it supersedes.');
  }
  if (memory.canonicalClaim === replacement.canonicalClaim) {
    throw new Error('A replacement memory must contain a different canonical claim.');
  }

  return transition(
    memory,
    'superseded',
    createEvent(memory, 'superseded', nowIso(now), action.actor, action.reason),
    { supersededBy: replacement.id },
  );
}

export function retractMemory(
  record: MemoryRecord,
  actionInput: z.input<typeof ExplicitActionSchema>,
  now = new Date(),
): MemoryRecord {
  const memory = parseRecord(record);
  const action = ExplicitActionSchema.parse(actionInput);

  if (memory.status === 'superseded' || memory.status === 'retracted' || memory.status === 'expired') {
    throw new Error(`Cannot retract a memory with status: ${memory.status}.`);
  }

  return transition(
    memory,
    'retracted',
    createEvent(memory, 'retracted', nowIso(now), action.actor, action.reason),
    { retractionReason: action.reason },
  );
}
