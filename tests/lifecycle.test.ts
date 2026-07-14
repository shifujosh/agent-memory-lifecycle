import { describe, expect, it } from 'vitest';
import {
  addEvidence,
  distinctSourceCount,
  evaluateLifecycle,
  proposeMemory,
  recordReview,
  retractMemory,
  supersedeMemory,
} from '../src/index.js';

const createdAt = new Date('2026-07-01T00:00:00.000Z');

function proposedMemory() {
  return proposeMemory(
    {
      id: 'contractor-access',
      claim: {
        subject: 'Acme contractor access',
        predicate: 'requires',
        value: 'manager approval',
      },
    },
    createdAt,
  );
}

describe('agent-memory-lifecycle', () => {
  it('confirms a proposed memory after an explicit accepted review', () => {
    const proposal = proposedMemory();
    const reviewed = recordReview(proposal, {
      id: 'review-1',
      reviewer: 'security-owner',
      decision: 'accepted',
      reviewedAt: '2026-07-02T00:00:00.000Z',
      reason: 'Reviewed against the signed access matrix.',
    });

    const evaluated = evaluateLifecycle(reviewed, {}, new Date('2026-07-02T01:00:00.000Z'));

    expect(evaluated.status).toBe('confirmed');
    expect(evaluated.events.at(-1)?.type).toBe('confirmed');
    expect(proposal.status).toBe('proposed');
    expect(proposal.reviews).toHaveLength(0);
  });

  it('confirms a proposed memory after two distinct source references', () => {
    const first = addEvidence(proposedMemory(), {
      id: 'evidence-1',
      sourceRef: 'security-runbook-v4',
      capturedAt: '2026-07-02T00:00:00.000Z',
    });
    const second = addEvidence(first, {
      id: 'evidence-2',
      sourceRef: 'signed-access-matrix-acme',
      capturedAt: '2026-07-03T00:00:00.000Z',
    });

    const evaluated = evaluateLifecycle(second, {}, new Date('2026-07-03T01:00:00.000Z'));

    expect(distinctSourceCount(second)).toBe(2);
    expect(evaluated.status).toBe('confirmed');
  });

  it('does not count duplicate source references toward confirmation', () => {
    const first = addEvidence(proposedMemory(), {
      id: 'evidence-1',
      sourceRef: 'security-runbook-v4',
      capturedAt: '2026-07-02T00:00:00.000Z',
    });
    const duplicateSource = addEvidence(first, {
      id: 'evidence-2',
      sourceRef: 'security-runbook-v4',
      capturedAt: '2026-07-03T00:00:00.000Z',
    });

    const evaluated = evaluateLifecycle(duplicateSource, {}, new Date('2026-07-03T01:00:00.000Z'));

    expect(distinctSourceCount(duplicateSource)).toBe(1);
    expect(evaluated.status).toBe('proposed');
  });

  it('expires only proposed memories after the inactivity window', () => {
    const expired = evaluateLifecycle(
      proposedMemory(),
      { proposedTtlDays: 30 },
      new Date('2026-07-31T00:00:00.000Z'),
    );

    const confirmed = evaluateLifecycle(
      recordReview(proposedMemory(), {
        id: 'review-1',
        reviewer: 'security-owner',
        decision: 'accepted',
        reviewedAt: '2026-07-02T00:00:00.000Z',
        reason: 'Reviewed.',
      }),
      {},
      new Date('2026-07-02T01:00:00.000Z'),
    );
    const later = evaluateLifecycle(confirmed, { proposedTtlDays: 1 }, new Date('2026-09-01T00:00:00.000Z'));

    expect(expired.status).toBe('expired');
    expect(later.status).toBe('confirmed');
  });

  it('requires explicit supersession and retraction events', () => {
    const confirmed = evaluateLifecycle(
      recordReview(proposedMemory(), {
        id: 'review-1',
        reviewer: 'security-owner',
        decision: 'accepted',
        reviewedAt: '2026-07-02T00:00:00.000Z',
        reason: 'Reviewed.',
      }),
      {},
      new Date('2026-07-02T01:00:00.000Z'),
    );

    const superseded = supersedeMemory(
      confirmed,
      'contractor-access-v2',
      'A reviewed contract amendment replaced the previous policy.',
      new Date('2026-08-01T00:00:00.000Z'),
    );
    const retracted = retractMemory(
      proposedMemory(),
      'The source document was withdrawn.',
      new Date('2026-07-02T00:00:00.000Z'),
    );

    expect(superseded.status).toBe('superseded');
    expect(superseded.supersededBy).toBe('contractor-access-v2');
    expect(retracted.status).toBe('retracted');
    expect(retracted.retractionReason).toBe('The source document was withdrawn.');
  });
});
