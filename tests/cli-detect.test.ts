import { describe, it, expect } from 'vitest';
import {
  detectAllClis,
  validateCliPath,
  type CliDetection,
  type DetectableCli,
} from '@/lib/cli-detect';

describe('cli-detect', () => {
  describe('detectAllClis', () => {
    it('returns array of 5 entries (one per DetectableCli)', () => {
      const clis = detectAllClis();
      expect(clis).toHaveLength(5);
    });

    it('each entry has id, found, optional path and source', () => {
      const clis = detectAllClis();
      const expectedIds: DetectableCli[] = [
        'claude-code',
        'codex-cli',
        'gemini-cli',
        'opencode-cli',
        'kimi-cli',
      ];

      clis.forEach((cli: CliDetection) => {
        expect(cli.id).toBeDefined();
        expect(expectedIds).toContain(cli.id);
        expect(typeof cli.found).toBe('boolean');

        if (cli.found) {
          expect(cli.path).toBeDefined();
          expect(typeof cli.path).toBe('string');
          expect(cli.source).toBeDefined();
          expect(['path', 'fallback', 'manual']).toContain(cli.source);
        } else {
          expect(cli.path).toBeUndefined();
          expect(cli.source).toBeUndefined();
        }
      });
    });
  });

  describe('validateCliPath', () => {
    it('returns found:false for nonexistent path', () => {
      const result = validateCliPath('claude-code', '/nonexistent/path/to/claude');
      expect(result.id).toBe('claude-code');
      expect(result.found).toBe(false);
    });

    it('returns found:false for empty/whitespace-only path', () => {
      const result = validateCliPath('codex-cli', '   ');
      expect(result.id).toBe('codex-cli');
      expect(result.found).toBe(false);
    });

    it('returns source:manual when found:true', () => {
      // This test depends on system state. If a CLI is installed and
      // we use its actual path, validate should return found:true with source:manual
      // For now, we skip this if no CLIs are found in a known location
      const clis = detectAllClis();
      const found = clis.find((c) => c.found);

      if (found && found.path) {
        const result = validateCliPath(found.id, found.path);
        expect(result.id).toBe(found.id);
        expect(result.found).toBe(true);
        expect(result.source).toBe('manual');
      }
    });
  });
});
