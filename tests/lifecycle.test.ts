import { describe, expect, it } from 'vitest';
import {
  addEvidence,
  decideLifecycle,
  evaluateLifecycle,
  independentSourceCount,
  LifecycleStatusSchema,
  MemoryRecordSchema,
  proposeMemory,
  recordReview,
  retractMemory,
  supersedeMemory,
} from '../src/index.js';

const createdAt = new Date('2026-07-01T00:00:00.000Z');
const scope = {
  namespace: 'customer:acme',
  appliesTo: 'contractor-access',
};
const integration = {
  id: 'support-ingestion',
  kind: 'integration' as const,
};
const securityOwner = {
  id: 'security-owner',
  kind: 'human' as const,
  authorityRef: 'access-control-owner',
};

function proposedMemory(id = 'contractor-access', value = 'manager approval') {
  return proposeMemory(
    {
      id,
      claim: {
        scope,
        subject: 'Acme contractor access',
        predicate: 'requires',
        value,
      },
    },
    createdAt,
  );
}

function evidence(
  id: string,
  sourceRef: string,
  independenceKey: string,
  capturedAt = '2026-07-02T00:00:00.000Z',
  kind: 'approved-policy' | 'unclassified' = 'approved-policy',
) {
  return {
    id,
    sourceRef,
    scope,
    authority: {
      kind,
      authorityRef: 'security-governance',
      independenceKey,
    },
    capturedAt,
    recordedBy: integration,
  };
}

function acceptedReview(id = 'review-1') {
  return {
    id,
    reviewer: securityOwner,
    decision: 'accepted' as const,
    reviewedAt: '2026-07-02T00:00:00.000Z',
    reason: 'Reviewed against the signed access matrix.',
  };
}

function confirmedMemory(id = 'contractor-access', value = 'manager approval') {
  const reviewed = recordReview(
    proposedMemory(id, value),
    acceptedReview(`review-${id}`),
    new Date('2026-07-02T01:00:00.000Z'),
  );
  return evaluateLifecycle(reviewed, {}, new Date('2026-07-02T02:00:00.000Z'));
}

describe('agent-memory-lifecycle', () => {
  it('confirms a proposed memory after an explicit accepted review', () => {
    const reviewed = recordReview(
      proposedMemory(),
      acceptedReview(),
      new Date('2026-07-02T01:00:00.000Z'),
    );

    const decision = decideLifecycle(reviewed, {}, new Date('2026-07-02T02:00:00.000Z'));

    expect(decision).toMatchObject({
      currentStatus: 'proposed',
      nextStatus: 'confirmed',
      transition: 'confirmed',
    });
    expect(decision.reason).toContain('security-owner');
  });

  it('confirms only after two qualified independent sources', () => {
    const first = addEvidence(
      proposedMemory(),
      evidence('evidence-1', 'security-runbook-v4', 'security-team'),
      new Date('2026-07-02T01:00:00.000Z'),
    );
    const second = addEvidence(
      first,
      evidence('evidence-2', 'signed-access-matrix-acme', 'customer-legal'),
      new Date('2026-07-03T01:00:00.000Z'),
    );

    expect(independentSourceCount(second)).toBe(2);
    expect(decideLifecycle(second, {}, new Date('2026-07-03T02:00:00.000Z')).nextStatus).toBe('confirmed');
  });

  it('does not treat two references from the same authority as independent', () => {
    const first = addEvidence(
      proposedMemory(),
      evidence('evidence-1', 'security-runbook-v4', 'security-team'),
      new Date('2026-07-02T01:00:00.000Z'),
    );
    const duplicateAuthority = addEvidence(
      first,
      evidence('evidence-2', 'security-runbook-v4-copy', 'security-team'),
      new Date('2026-07-03T01:00:00.000Z'),
    );

    expect(independentSourceCount(duplicateAuthority)).toBe(1);
    expect(decideLifecycle(duplicateAuthority, {}, new Date('2026-07-03T02:00:00.000Z')).nextStatus).toBe('proposed');
  });

  it('does not let unclassified evidence confirm a claim', () => {
    const unclassified = addEvidence(
      proposedMemory(),
      evidence('evidence-1', 'support-ticket-193', 'support-ticket-193', '2026-07-02T00:00:00.000Z', 'unclassified'),
      new Date('2026-07-02T01:00:00.000Z'),
    );

    expect(independentSourceCount(unclassified)).toBe(0);
    expect(decideLifecycle(unclassified).nextStatus).toBe('proposed');
  });

  it('uses the time evidence was recorded, not the age of the source, for expiry', () => {
    const updated = addEvidence(
      proposedMemory(),
      evidence('evidence-1', 'archived-runbook-v1', 'security-team', '2026-05-01T00:00:00.000Z'),
      new Date('2026-07-31T00:00:00.000Z'),
    );

    expect(updated.lastActivityAt).toBe('2026-07-31T00:00:00.000Z');
    expect(decideLifecycle(updated, {}, new Date('2026-07-31T00:00:00.000Z')).nextStatus).toBe('proposed');
    expect(decideLifecycle(updated, {}, new Date('2026-08-30T00:00:00.000Z')).nextStatus).toBe('expired');
  });

  it('rejects future source timestamps and scope mismatches', () => {
    expect(() =>
      addEvidence(
        proposedMemory(),
        evidence('future-evidence', 'future-source', 'future-source', '2026-07-03T00:00:00.000Z'),
        new Date('2026-07-02T00:00:00.000Z'),
      ),
    ).toThrow('capturedAt');

    expect(() =>
      addEvidence(
        proposedMemory(),
        {
          ...evidence('other-scope', 'other-source', 'other-source'),
          scope: { namespace: 'customer:other', appliesTo: 'contractor-access' },
        },
        new Date('2026-07-02T01:00:00.000Z'),
      ),
    ).toThrow('scope');
  });

  it('enforces lifecycle invariants and freezes returned records', () => {
    const proposal = proposedMemory();
    const invalid = structuredClone(proposal);
    invalid.status = 'confirmed';

    expect(() => MemoryRecordSchema.parse(invalid)).toThrow('confirmed event');
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.events)).toBe(true);
    expect(Object.isFrozen(proposal.events[0])).toBe(true);
  });

  it('requires a confirmed replacement in the same scope for supersession', () => {
    const current = confirmedMemory();
    const replacement = confirmedMemory('contractor-access-v2', 'department owner approval');

    const superseded = supersedeMemory(
      current,
      replacement,
      {
        actor: securityOwner,
        reason: 'A reviewed contract amendment replaced the previous policy.',
      },
      new Date('2026-08-01T00:00:00.000Z'),
    );

    expect(superseded.status).toBe('superseded');
    expect(superseded.supersededBy).toBe('contractor-access-v2');
    expect(superseded.events.at(-1)?.actor).toEqual(securityOwner);

    const otherScope = confirmedMemory('other-scope', 'manager approval');
    const otherScopeMutable = structuredClone(otherScope);
    otherScopeMutable.claim.scope.namespace = 'customer:other';
    otherScopeMutable.canonicalClaim = otherScopeMutable.canonicalClaim.replace('customer:acme', 'customer:other');
    expect(() =>
      supersedeMemory(
        current,
        MemoryRecordSchema.parse(otherScopeMutable),
        { actor: securityOwner, reason: 'Invalid cross-customer replacement.' },
      ),
    ).toThrow('same scope');
  });

  it('requires a named human action to retract a memory', () => {
    const retracted = retractMemory(
      proposedMemory(),
      {
        actor: securityOwner,
        reason: 'The source document was withdrawn.',
      },
      new Date('2026-07-02T00:00:00.000Z'),
    );

    expect(retracted.status).toBe('retracted');
    expect(retracted.retractionReason).toBe('The source document was withdrawn.');
    expect(retracted.events.at(-1)?.actor.id).toBe('security-owner');
  });

  it('keeps rejected reviews proposed until another rule resolves the claim', () => {
    const rejected = recordReview(
      proposedMemory(),
      {
        ...acceptedReview(),
        decision: 'rejected',
        reason: 'The access matrix is not yet signed.',
      },
      new Date('2026-07-02T01:00:00.000Z'),
    );

    expect(decideLifecycle(rejected).nextStatus).toBe('proposed');
  });

  it('exposes only defined lifecycle statuses', () => {
    expect(LifecycleStatusSchema.options).toEqual([
      'proposed',
      'confirmed',
      'superseded',
      'retracted',
      'expired',
    ]);
  });
});
