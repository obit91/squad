/**
 * CI tests for the Scribe charter in scribe-charter.md.
 *
 * Verifies that:
 *  - The numbered task list is present in the "How I Work" section
 *  - HARD GATE enforcement is documented (decisions archival ceiling)
 *  - Decision inbox merge is a numbered step
 *  - Deduplication is a numbered step
 *  - A commit step is present
 *  - "Never speak to the user." is the final numbered step (Scribe stays invisible)
 *  - Commit step precedes the "never speak" step
 *
 * Canonical source: .squad-templates/scribe-charter.md
 *
 * Note: The Scribe section was extracted from squad.agent.md into this
 * standalone charter in PR #1035. The original test checked for
 * PRE-CHECK / HEALTH REPORT / GIT COMMIT task labels and an exact
 * 20480-byte threshold, which are not present in the new charter.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function readTemplate(): string {
  return readFileSync(resolve(ROOT, '.squad-templates/scribe-charter.md'), 'utf-8');
}

/**
 * Extract the Scribe numbered task block from the charter.
 * Returns the substring from "After every substantial work session:"
 * up to and including the "Never speak to the user." step.
 */
function extractScribeTaskBlock(content: string): string {
  const startMarker = 'After every substantial work session:';
  const endMarker = '6. **Never speak to the user.**';
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error('Could not locate Scribe task block in charter');
  }
  return content.slice(start, end + endMarker.length);
}

describe('Scribe charter — task structure and HARD GATE enforcement', () => {
  const content = readTemplate();
  const taskBlock = extractScribeTaskBlock(content);

  it('numbered task list is present', () => {
    const numberedLines = taskBlock
      .split('\n')
      .filter(l => l.trim().match(/^\d+\./));
    expect(numberedLines.length, 'No numbered tasks found in task block').toBeGreaterThan(0);
  });

  it('decision inbox merge is a numbered step', () => {
    expect(taskBlock, 'Decision inbox merge step not found').toContain('Merge the decision inbox');
  });

  it('deduplication step is present', () => {
    expect(taskBlock, 'Deduplication step not found').toContain('Deduplicate');
  });

  it('commit step is present', () => {
    expect(taskBlock, 'Commit step not found').toContain('Commit');
  });

  it('HARD GATE enforcement is documented in the charter', () => {
    expect(content, 'HARD GATE label missing from charter').toContain('HARD GATE');
  });

  it('"Never speak to the user." is the final numbered step', () => {
    const numberedLines = taskBlock
      .split('\n')
      .filter(l => l.trim().match(/^\d+\./));
    expect(numberedLines.length, 'No numbered tasks found').toBeGreaterThan(0);
    expect(
      numberedLines[numberedLines.length - 1],
      'Last numbered step must be "Never speak to the user."'
    ).toContain('Never speak to the user');
  });

  it('commit step precedes "Never speak to the user."', () => {
    const commitIndex = taskBlock.indexOf('Commit');
    const neverSpeakIndex = taskBlock.indexOf('Never speak to the user.');
    expect(commitIndex, 'Commit step not found in task block').toBeGreaterThan(-1);
    expect(neverSpeakIndex, '"Never speak to the user." not found in task block').toBeGreaterThan(-1);
    expect(commitIndex, 'Commit must precede "Never speak to the user."').toBeLessThan(neverSpeakIndex);
  });
});
