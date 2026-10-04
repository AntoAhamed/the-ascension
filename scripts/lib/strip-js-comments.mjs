/**
 * Remove comments from JavaScript source, leaving string literals intact.
 *
 * WHY THIS EXISTS
 *   Several tests in this repo assert that source does NOT contain something, or
 *   that it DOES contain something in executable code. Both directions are broken
 *   by comments, because a comment can contain any text at all:
 *
 *     - A negative scan finds the pattern in the comment that explains why the
 *       pattern is absent. "No window.confirm()" then fails against the prose
 *       saying there isn't one. The same thing happened to check-schema.mjs, where
 *       SQL `--` comments tripped a guard's own regex literals.
 *     - A positive scan passes on prose rather than on code. While writing
 *       test-cors-origins.mjs I asserted that api.js branches on
 *       import.meta.env.DEV, deleted the branch, and the assertion still passed —
 *       the token appeared in the doc comment directly above it.
 *
 *   The second failure is the more dangerous one, because a test that passes for
 *   the wrong reason is worse than no test: it reports coverage while providing
 *   none. So every source scan in this repo runs against stripped output.
 *
 * WHY IT IS NOT A REGEX
 *   Comments cannot be matched with a regular expression, because a `//` inside a
 *   string is not a comment. Deleting it would truncate the line and take real
 *   code out of the scan — deleting a `//` from 'http://localhost:5173' leaves an
 *   unterminated string, and everything after it is then misparsed. The same
 *   hazard applies to regex literals, which is why a scan over this repo's own
 *   sources needs a state machine rather than a pattern.
 *
 * KNOWN LIMITATIONS
 *   - Regex literals are not tracked as a state. A `/` that opens a regex
 *     containing `//` or `/*` would be misread. No source file this is used on
 *     contains such a literal; a `//` immediately following a `)` in *code*
 *     position would be a syntax error anyway.
 *   - Comments are deleted, not blanked, so byte offsets in the result do not
 *     correspond to the input. Newlines inside comments are preserved so line
 *     numbers still line up, which is what callers actually use.
 *
 * @param {string} source
 * @returns {string} the same source with comments removed
 */
export function stripJsComments(source) {
  let out = '';
  let i = 0;
  // 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let state = 'code';

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      out += c;
      i += 1;
    } else if (state === 'line') {
      // Keep the newline so it still terminates the comment for the reader.
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i += 1;
    } else if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        i += 2;
      } else if (c === '\n') {
        // Preserve newlines so line numbers in failure messages stay meaningful.
        out += c;
        i += 1;
      } else {
        i += 1;
      }
    } else {
      // Inside a string literal: copy verbatim, honouring escapes so that a
      // quote preceded by a backslash does not look like the end of the string.
      if (c === '\\') {
        out += c + (next ?? '');
        i += 2;
        continue;
      }
      if (
        (state === 'single' && c === "'") ||
        (state === 'double' && c === '"') ||
        (state === 'template' && c === '`')
      ) {
        state = 'code';
      }
      out += c;
      i += 1;
    }
  }

  return out;
}
