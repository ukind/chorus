import { describe, it, expect } from 'vitest';
import { verdictFromReviewerText } from '../src/daemon/runner/verdict';

const PAD =
  'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';

function long(verdict: string): string {
  return PAD.repeat(2) + ' ' + verdict + '\n## DONE\n';
}

describe('verdictFromReviewerText', () => {
  it('returns null for empty input', () => {
    expect(verdictFromReviewerText('')).toBeNull();
  });

  it('returns null for under-20-char content (incl after stripping ## DONE)', () => {
    expect(verdictFromReviewerText('ok\n## DONE')).toBeNull();
    expect(verdictFromReviewerText('y\n## DONE')).toBeNull();
  });

  it('detects approve at the tail', () => {
    expect(verdictFromReviewerText(long('I approve this change.'))).toBe(true);
  });

  it('detects lgtm at the tail', () => {
    expect(verdictFromReviewerText(long('lgtm'))).toBe(true);
  });

  it('returns true for minimal LGTM-style verdict', () => {
    expect(verdictFromReviewerText('LGTM, no concerns here. ## DONE')).toBe(true);
  });

  it('detects "ship it" at the tail', () => {
    expect(verdictFromReviewerText(long('overall solid — ship it'))).toBe(true);
  });

  it('detects request changes', () => {
    expect(verdictFromReviewerText(long('request changes here'))).toBe(false);
  });

  it('detects rejected', () => {
    expect(verdictFromReviewerText(long('this PR is rejected'))).toBe(false);
  });

  it('detects "blocker"', () => {
    expect(verdictFromReviewerText(long('there is one blocker we need to fix'))).toBe(false);
  });

  it('avoids false-positive on "approached" (word boundary)', () => {
    // "approached" should NOT be matched as "approve" because of \b
    const text =
      PAD.repeat(2) +
      ' the team approached the problem analytically with no clear conclusion';
    expect(verdictFromReviewerText(text)).toBeNull();
  });

  it('terse but explicit verdict bypasses the length floor', () => {
    // Pre-fix this returned null because the 20-char floor ran BEFORE the
    // regex. That dropped valid short replies like "approve ## DONE" (15
    // chars). Verdict keywords now win regardless of length.
    expect(verdictFromReviewerText('lgtm everywhere\n## DONE')).toBe(true);
    expect(verdictFromReviewerText('approve\n## DONE')).toBe(true);
    expect(verdictFromReviewerText('reject\n## DONE')).toBe(false);
  });

  it('negative wins over positive when both appear', () => {
    // "approved-overall but blocker on auth" — has "approve" but also "blocker"
    const mixed = long('initially approved overall but there is a blocker on auth');
    expect(verdictFromReviewerText(mixed)).toBe(false);
  });

  it('falls back to whole-text scan when tail is silent', () => {
    // Long analytical body with verdict deep in middle, tail with no verdict
    const longTail = ' ' + 'x'.repeat(500);
    const text = PAD + 'I approve this' + PAD + longTail + '\n## DONE';
    expect(verdictFromReviewerText(text)).toBe(true);
  });

  // Contraction handling — added after launch-eve review (deepseek + gemini)
  // flagged that "don't approve" / "can't approve" silently slipped past
  // the negative regex, scanning as ambiguous (null) and letting a phase
  // auto-pass on a reviewer who explicitly meant to block.
  it('detects "don\'t approve" (straight apostrophe)', () => {
    expect(verdictFromReviewerText(long("I don't approve — needs error handling"))).toBe(false);
  });

  it('detects "don’t approve" (typographic apostrophe — common from LLM emit)', () => {
    expect(verdictFromReviewerText(long('I don’t approve, the diff is racy'))).toBe(false);
  });

  it('detects "can\'t approve"', () => {
    expect(verdictFromReviewerText(long("Can't approve in current shape"))).toBe(false);
  });

  it('detects "can’t approve" (typographic)', () => {
    expect(verdictFromReviewerText(long('I can’t approve this'))).toBe(false);
  });

  it('detects "do not approve"', () => {
    expect(verdictFromReviewerText(long('Do not approve — too risky'))).toBe(false);
  });

  it('detects "cannot approve"', () => {
    expect(verdictFromReviewerText(long('Cannot approve as-is'))).toBe(false);
  });

  it('detects "don\'t merge"', () => {
    expect(verdictFromReviewerText(long("Don't merge yet"))).toBe(false);
  });
});
