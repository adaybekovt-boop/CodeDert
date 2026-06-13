/**
 * Pure helper for recovering from a failed `edit_file` match.
 *
 * No electron / node imports on purpose — unit-tested in isolation
 * (tests/workspace-fuzzy.test.ts). Used by workspace.applyEdit.
 */

/**
 * Rewrite `target`'s line endings to match the convention used by `sample`
 * (the on-disk file). Models routinely emit LF even when the file is CRLF (or
 * vice-versa), so a byte-exact match of an otherwise-correct fragment fails.
 * Normalizing the model's old_string/new_string to the file's EOL both fixes
 * the match and prevents writing mixed endings back into the file.
 */
export function matchLineEndings(target: string, sample: string): string {
  const eol = sample.includes('\r\n') ? '\r\n' : '\n';
  return target.replace(/\r\n/g, '\n').replace(/\n/g, eol);
}

/**
 * When an `edit_file` old_string fails to match byte-for-byte, find the region
 * of the file the model most likely *meant* — matching on trimmed line content
 * so indentation, trailing whitespace and CRLF/LF differences don't defeat it.
 * Returns the EXACT bytes of that region so the model can copy them verbatim
 * and retry. The #1 cause of broken edits is whitespace drift; handing back
 * the real fragment turns a dead end into a one-shot fix.
 */
export function findClosestFragment(
  content: string,
  oldString: string
): { fragment: string; startLine: number; endLine: number } | null {
  const norm = (s: string) => s.replace(/\r\n/g, '\n');
  const fileLines = norm(content).split('\n');
  const oldLines = norm(oldString).split('\n');
  // Drop leading/trailing blank lines the model may have padded with.
  while (oldLines.length && oldLines[0].trim() === '') oldLines.shift();
  while (oldLines.length && oldLines[oldLines.length - 1].trim() === '') oldLines.pop();
  if (oldLines.length === 0) return null;

  const key = (s: string) => s.trim();
  const wanted = oldLines.map(key);

  // Slide a window the size of the wanted block across the file; accept a
  // window where every trimmed line matches. Require uniqueness so we never
  // hand back an ambiguous region.
  const matches: number[] = [];
  for (let i = 0; i + wanted.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < wanted.length; j++) {
      if (key(fileLines[i + j]) !== wanted[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
    if (matches.length > 1) break;
  }
  if (matches.length !== 1) return null;

  const start = matches[0];
  const fragment = fileLines.slice(start, start + wanted.length).join('\n');
  return { fragment, startLine: start + 1, endLine: start + wanted.length };
}
