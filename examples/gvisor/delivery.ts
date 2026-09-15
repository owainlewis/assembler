import type { Feedback } from '../../src/github.js';
import { z } from '../../src/index.js';

export const deliveryResult = z.object({
  status: z.enum(['ready', 'blocked', 'no_changes']),
  summary: z.string().min(1),
});

export function requireReady(snapshot: Feedback, head: string) {
  if (snapshot.head !== head) throw new Error('PR head changed after agent completion');
  if (snapshot.ci !== 'passed') throw new Error('PR checks have not passed');
  if (snapshot.items.some(item => item.threadId)) throw new Error('Unresolved review threads remain');
  if (snapshot.reviewDecision === 'CHANGES_REQUESTED' || snapshot.reviewDecision === 'REVIEW_REQUIRED')
    throw new Error('Required GitHub review remains outstanding');
  if (snapshot.isDraft !== false || snapshot.mergeable !== 'MERGEABLE') throw new Error('PR is draft, conflicting or mergeability is unknown');
}
