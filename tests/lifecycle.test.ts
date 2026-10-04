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
      basis: {
        qualifiedIndependentSources: 0,
        requiredIndependentSources: 2,
        latestReview: 'accepted',
      },
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

  it('normalizes independence keys before counting corroboration', () => {
    const first = addEvidence(
      proposedMemory(),
      evidence('evidence-1', 'security-runbook-v4', 'Acme Security Team'),
      new Date('2026-07-02T01:00:00.000Z'),
    );
    const sameAuthority = addEvidence(
      first,
      evidence('evidence-2', 'security-addendum-v2', ' acme   security team '),
      new Date('2026-07-03T01:00:00.000Z'),
    );

    expect(independentSourceCount(sameAuthority)).toBe(1);
  });

  it('rejects duplicate source references even when their IDs differ', () => {
    const first = addEvidence(
      proposedMemory(),
      evidence('evidence-1', 'security-runbook-v4', 'security-team'),
      new Date('2026-07-02T01:00:00.000Z'),
    );

    expect(() =>
      addEvidence(
        first,
        evidence('evidence-2', ' SECURITY-RUNBOOK-V4 ', 'customer-legal'),
        new Date('2026-07-03T01:00:00.000Z'),
      ),
    ).toThrow('sourceRef');
  });

  it('does not let unclassified evidence confirm a claim', () => {
    const unclassified = addEvidence(
      proposedMemory(),
      evidence('evidence-1', 'support-ticket-193', 'support-ticket-193', '2026-07-02T00:00:00.000Z', 'unclassified'),
      new Date('2026-07-02T01:00:00.000Z'),
    );

    expect(independentSourceCount(unclassified)).toBe(0);
    expect(decideLifecycle(unclassified, {}, new Date('2026-07-02T02:00:00.000Z')).nextStatus).toBe('proposed');
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

  it('validates attached evidence scope again when records are rehydrated', () => {
    const recorded = addEvidence(
      proposedMemory(),
      evidence('evidence-1', 'security-runbook-v4', 'security-team'),
      new Date('2026-07-02T01:00:00.000Z'),
    );
    const forged = structuredClone(recorded);
    forged.evidence[0].scope.namespace = 'customer:other';

    expect(() => MemoryRecordSchema.parse(forged)).toThrow('Evidence scope must match');
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

    const decision = decideLifecycle(rejected, {}, new Date('2026-07-02T02:00:00.000Z'));

    expect(decision).toMatchObject({
      nextStatus: 'proposed',
      transition: null,
      basis: { latestReview: 'rejected' },
    });
    expect(decision.reason).toContain('blocks automatic confirmation');
  });

  it('lets the latest human review block corroboration until a later acceptance', () => {
    const first = addEvidence(
      proposedMemory(),
      evidence('evidence-1', 'security-runbook-v4', 'security-team'),
      new Date('2026-07-02T01:00:00.000Z'),
    );
    const corroborated = addEvidence(
      first,
      evidence('evidence-2', 'signed-access-matrix-acme', 'customer-legal'),
      new Date('2026-07-03T01:00:00.000Z'),
    );
    const rejected = recordReview(
      corroborated,
      {
        ...acceptedReview(),
        decision: 'rejected',
        reviewedAt: '2026-07-03T02:00:00.000Z',
        reason: 'The signed matrix is being amended.',
      },
      new Date('2026-07-03T02:01:00.000Z'),
    );

    expect(decideLifecycle(rejected, {}, new Date('2026-07-03T03:00:00.000Z'))).toMatchObject({
      nextStatus: 'proposed',
      transition: null,
      basis: { qualifiedIndependentSources: 2, latestReview: 'rejected' },
    });

    const accepted = recordReview(
      rejected,
      {
        ...acceptedReview('review-2'),
        reviewedAt: '2026-07-03T04:00:00.000Z',
        reason: 'The amended matrix is now approved.',
      },
      new Date('2026-07-03T04:01:00.000Z'),
    );

    expect(decideLifecycle(accepted, {}, new Date('2026-07-03T05:00:00.000Z')).nextStatus).toBe('confirmed');
  });

  it('requires review decisions to have an unambiguous order', () => {
    const accepted = recordReview(
      proposedMemory(),
      acceptedReview(),
      new Date('2026-07-02T01:00:00.000Z'),
    );

    expect(() =>
      recordReview(
        accepted,
        {
          ...acceptedReview('review-2'),
          decision: 'rejected',
          reviewedAt: '2026-07-01T23:00:00.000Z',
          reason: 'Out-of-order review.',
        },
        new Date('2026-07-02T02:00:00.000Z'),
      ),
    ).toThrow('later than the latest');
  });

  it('rejects a policy evaluation from before the latest activity', () => {
    const updated = addEvidence(
      proposedMemory(),
      evidence('evidence-1', 'security-runbook-v4', 'security-team'),
      new Date('2026-07-02T01:00:00.000Z'),
    );

    expect(() => decideLifecycle(updated, {}, new Date('2026-07-02T00:30:00.000Z'))).toThrow(
      'Evaluation time cannot precede',
    );
  });

  it('rejects duplicate authority kinds in a policy', () => {
    expect(() =>
      decideLifecycle(proposedMemory(), {
        qualifyingAuthorityKinds: ['approved-policy', 'approved-policy'],
      }),
    ).toThrow('must not contain duplicates');
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
