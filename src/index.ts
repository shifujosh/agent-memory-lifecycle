import { z } from 'zod';

export const LifecycleStatusSchema = z.enum([
  'proposed',
  'confirmed',
  'superseded',
  'retracted',
  'expired',
]);
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

export const ClaimSchema = z.object({
  subject: z.string().trim().min(1),
  predicate: z.string().trim().min(1),
  value: z.string().trim().min(1),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const EvidenceSchema = z.object({
  id: z.string().trim().min(1),
  sourceRef: z.string().trim().min(1),
  capturedAt: z.string().datetime(),
  summary: z.string().trim().min(1).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ReviewSchema = z.object({
  id: z.string().trim().min(1),
  reviewer: z.string().trim().min(1),
  decision: z.enum(['accepted', 'rejected']),
  reviewedAt: z.string().datetime(),
  reason: z.string().trim().min(1),
});
export type Review = z.infer<typeof ReviewSchema>;

export const LifecycleEventSchema = z.object({
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
  reason: z.string().trim().min(1),
});
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

export const MemoryRecordSchema = z.object({
  id: z.string().trim().min(1),
  claim: ClaimSchema,
  status: LifecycleStatusSchema,
  evidence: z.array(EvidenceSchema),
  reviews: z.array(ReviewSchema),
  events: z.array(LifecycleEventSchema),
  createdAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  supersededBy: z.string().trim().min(1).optional(),
  retractionReason: z.string().trim().min(1).optional(),
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const LifecyclePolicySchema = z.object({
  requiredDistinctSources: z.number().int().min(2).default(2),
  proposedTtlDays: z.number().int().min(1).default(30),
});
export type LifecyclePolicy = z.infer<typeof LifecyclePolicySchema>;

export const LifecycleDecisionSchema = z.object({
  currentStatus: LifecycleStatusSchema,
  nextStatus: LifecycleStatusSchema,
  transition: z.enum(['confirmed', 'expired']).nullable(),
  reason: z.string().trim().min(1),
});
export type LifecycleDecision = z.infer<typeof LifecycleDecisionSchema>;

export const DEFAULT_POLICY: LifecyclePolicy = {
  requiredDistinctSources: 2,
  proposedTtlDays: 30,
};

const ProposalInputSchema = z.object({
  id: z.string().trim().min(1),
  claim: ClaimSchema,
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function appendEvent(
  record: MemoryRecord,
  event: LifecycleEvent,
  changes: Partial<MemoryRecord> = {},
): MemoryRecord {
  return MemoryRecordSchema.parse({
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

export function proposeMemory(
  input: z.input<typeof ProposalInputSchema>,
  now = new Date(),
): MemoryRecord {
  const proposal = ProposalInputSchema.parse(input);
  const timestamp = nowIso(now);

  return MemoryRecordSchema.parse({
    id: proposal.id,
    claim: proposal.claim,
    status: 'proposed',
    evidence: [],
    reviews: [],
    events: [
      {
        type: 'proposed',
        occurredAt: timestamp,
        reason: 'Claim entered the lifecycle as proposed.',
      },
    ],
    createdAt: timestamp,
    lastActivityAt: timestamp,
  });
}

export function addEvidence(
  record: MemoryRecord,
  evidenceInput: z.input<typeof EvidenceSchema>,
): MemoryRecord {
  const memory = MemoryRecordSchema.parse(record);
  const evidence = EvidenceSchema.parse(evidenceInput);
  assertProposed(memory);

  if (memory.evidence.some((item) => item.id === evidence.id)) {
    throw new Error(`Evidence ID "${evidence.id}" already exists on this memory.`);
  }

  return appendEvent(
    memory,
    {
      type: 'evidence_added',
      occurredAt: evidence.capturedAt,
      reason: `Evidence recorded from ${evidence.sourceRef}.`,
    },
    { evidence: [...memory.evidence, evidence] },
  );
}

export function recordReview(
  record: MemoryRecord,
  reviewInput: z.input<typeof ReviewSchema>,
): MemoryRecord {
  const memory = MemoryRecordSchema.parse(record);
  const review = ReviewSchema.parse(reviewInput);
  assertProposed(memory);

  if (memory.reviews.some((item) => item.id === review.id)) {
    throw new Error(`Review ID "${review.id}" already exists on this memory.`);
  }

  return appendEvent(
    memory,
    {
      type: 'review_recorded',
      occurredAt: review.reviewedAt,
      reason: `Review recorded from ${review.reviewer}: ${review.decision}.`,
    },
    { reviews: [...memory.reviews, review] },
  );
}

export function distinctSourceCount(record: MemoryRecord): number {
  return new Set(record.evidence.map((item) => item.sourceRef)).size;
}

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
  const memory = MemoryRecordSchema.parse(record);
  const policy = LifecyclePolicySchema.parse({ ...DEFAULT_POLICY, ...policyInput });

  if (memory.status !== 'proposed') {
    return LifecycleDecisionSchema.parse({
      currentStatus: memory.status,
      nextStatus: memory.status,
      transition: null,
      reason: `No automatic transition is permitted for ${memory.status} memories.`,
    });
  }

  const acceptedReview = memory.reviews.find((review) => review.decision === 'accepted');
  if (acceptedReview) {
    return LifecycleDecisionSchema.parse({
      currentStatus: 'proposed',
      nextStatus: 'confirmed',
      transition: 'confirmed',
      reason: `Confirmed by accepted review from ${acceptedReview.reviewer}.`,
    });
  }

  const sourceCount = distinctSourceCount(memory);
  if (sourceCount >= policy.requiredDistinctSources) {
    return LifecycleDecisionSchema.parse({
      currentStatus: 'proposed',
      nextStatus: 'confirmed',
      transition: 'confirmed',
      reason: `Confirmed by ${sourceCount} distinct source references.`,
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
    });
  }

  return LifecycleDecisionSchema.parse({
    currentStatus: 'proposed',
    nextStatus: 'proposed',
    transition: null,
    reason: `Still proposed: ${sourceCount} of ${policy.requiredDistinctSources} distinct source references and no accepted review.`,
  });
}

export function evaluateLifecycle(
  record: MemoryRecord,
  policyInput: Partial<LifecyclePolicy> = {},
  now = new Date(),
): MemoryRecord {
  const memory = MemoryRecordSchema.parse(record);
  const decision = decideLifecycle(memory, policyInput, now);

  if (!decision.transition) {
    return clone(memory);
  }

  return transition(memory, decision.nextStatus, {
    type: decision.transition,
    occurredAt: nowIso(now),
    reason: decision.reason,
  });
}

export function supersedeMemory(
  record: MemoryRecord,
  replacementId: string,
  reason: string,
  now = new Date(),
): MemoryRecord {
  const memory = MemoryRecordSchema.parse(record);
  const replacement = z.string().trim().min(1).parse(replacementId);
  const explanation = z.string().trim().min(1).parse(reason);

  if (memory.status !== 'confirmed') {
    throw new Error('Only confirmed memories can be superseded.');
  }
  if (memory.id === replacement) {
    throw new Error('A memory cannot supersede itself.');
  }

  return transition(
    memory,
    'superseded',
    {
      type: 'superseded',
      occurredAt: nowIso(now),
      reason: explanation,
    },
    { supersededBy: replacement },
  );
}

export function retractMemory(
  record: MemoryRecord,
  reason: string,
  now = new Date(),
): MemoryRecord {
  const memory = MemoryRecordSchema.parse(record);
  const explanation = z.string().trim().min(1).parse(reason);

  if (memory.status === 'superseded' || memory.status === 'retracted' || memory.status === 'expired') {
    throw new Error(`Cannot retract a memory with status: ${memory.status}.`);
  }

  return transition(
    memory,
    'retracted',
    {
      type: 'retracted',
      occurredAt: nowIso(now),
      reason: explanation,
    },
    { retractionReason: explanation },
  );
}
