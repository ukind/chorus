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

  it('returns null for under-80-char content (incl after stripping ## DONE)', () => {
    expect(verdictFromReviewerText('approve\n## DONE')).toBeNull();
    expect(verdictFromReviewerText('lgtm\n## DONE')).toBeNull();
  });

  it('detects approve at the tail', () => {
    expect(verdictFromReviewerText(long('I approve this change.'))).toBe(true);
  });

  it('detects lgtm at the tail', () => {
    expect(verdictFromReviewerText(long('lgtm'))).toBe(true);
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

  it('strips trailing ## DONE before length check', () => {
    const tooShortAfterStrip = 'lgtm everywhere\n## DONE';
    expect(verdictFromReviewerText(tooShortAfterStrip)).toBeNull();
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
});
