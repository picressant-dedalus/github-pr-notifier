// Minimal CODEOWNERS parser/matcher, used to know whether a PR needs a review from a given team.
// Follows GitHub's rules: gitignore-like patterns, and the LAST matching line wins.
// https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners

/** Candidate CODEOWNERS locations, in the order GitHub looks for them. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

function escapeRegex(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Converts a CODEOWNERS pattern to a RegExp matching repository-relative file paths. */
export function patternToRegex(pattern) {
  let p = pattern.trim();
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.replace(/\/+$/, '');
  // A slash at the start or in the middle anchors the pattern to the repository root.
  const anchored = p.startsWith('/') || p.includes('/');
  p = p.replace(/^\/+/, '');

  let body = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          body += '(?:.*/)?';
          i += 2;
        } else {
          body += '.*';
          i += 1;
        }
      } else {
        body += '[^/]*';
      }
    } else if (c === '?') {
      body += '[^/]';
    } else {
      body += escapeRegex(c);
    }
  }

  const prefix = anchored ? '^' : '^(?:.*/)?';
  // A directory pattern matches everything below it; a plain pattern matches the file itself
  // or, if it names a directory, everything below it. Exception documented by GitHub:
  // "docs/*" matches docs/a.md but not nested files like docs/sub/a.md.
  const shallow = /(^|\/)\*$/.test(p);
  const suffix = dirOnly ? '/.*$' : shallow ? '$' : '(?:/.*)?$';
  return new RegExp(prefix + body + suffix);
}

/** Parses CODEOWNERS text into [{ pattern, regex, owners: string[] }] (owners lower-cased). */
export function parseCodeowners(text) {
  const rules = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    try {
      rules.push({
        pattern,
        regex: patternToRegex(pattern),
        owners: owners.map((o) => o.toLowerCase())
      });
    } catch {
      // Ignore invalid patterns, like GitHub does.
    }
  }
  return rules;
}

/** Returns the owners of a file path (last matching rule wins), or [] if none. */
export function ownersOf(rules, path) {
  for (let i = rules.length - 1; i >= 0; i--) {
    if (rules[i].regex.test(path)) return rules[i].owners;
  }
  return [];
}

/**
 * True if at least one of the changed files is owned by `@org/teamSlug`.
 * @param {ReturnType<typeof parseCodeowners>} rules
 * @param {string[]} files
 */
export function teamOwnsAnyFile(rules, files, org, teamSlug) {
  if (!rules.length || !teamSlug) return false;
  const team = `@${org}/${teamSlug}`.toLowerCase();
  return files.some((file) => ownersOf(rules, file).includes(team));
}
