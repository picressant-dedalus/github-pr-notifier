import { ownersOf, parseCodeowners, patternToRegex, teamOwnsAnyFile } from '../js/codeowners.js';
import { CODEOWNERS } from './helpers.js';

const TEAM = 'cis4u-r-d-orbis-medication-admins';

describe('patternToRegex', () => {
  const cases = [
    ['/.github/', '.github/workflows/ci.yml', true],
    ['/.github/', 'sub/.github/x', false],
    ['pom.xml', 'pom.xml', true],
    ['pom.xml', 'module/pom.xml', true],
    ['pom.xml', 'pom.xml.bak', false],
    ['Jenkinsfile*', 'ci/Jenkinsfile.release', true],
    ['*.js', 'a/b/c.js', true],
    ['docs/*', 'docs/a.md', true],
    ['docs/*', 'docs/sub/a.md', false],
    ['docs/*', 'x/docs/a.md', false],
    ['apps/', 'x/apps/y.txt', true],
    ['**/logs', 'deep/a/logs/x.log', true],
    ['/build/**/out', 'build/a/b/out', true],
    ['src', 'src/a/b.java', true],
    ['?.txt', 'a.txt', true],
    ['?.txt', 'ab.txt', false]
  ];
  it.each(cases)('%s matches %s -> %s', (pattern, path, expected) => {
    expect(patternToRegex(pattern).test(path)).toBe(expected);
  });
});

describe('CODEOWNERS ownership', () => {
  const rules = parseCodeowners(CODEOWNERS);

  it('ignores comments and parses owners lower-cased', () => {
    expect(rules).toHaveLength(3);
    expect(rules[1].owners).toEqual([`@dedalus-cis4u/${TEAM}`, '@picressant-dedalus']);
  });

  it('uses the last matching rule', () => {
    const r = parseCodeowners('* @org/everyone\n/docs/ @org/docs');
    expect(ownersOf(r, 'docs/a.md')).toEqual(['@org/docs']);
    expect(ownersOf(r, 'src/a.md')).toEqual(['@org/everyone']);
    expect(ownersOf(parseCodeowners('* @org/a\n/docs/'), 'docs/x')).toEqual([]);
  });

  it('detects whether the team owns one of the changed files', () => {
    expect(teamOwnsAnyFile(rules, ['src/A.java', 'pom.xml'], 'dedalus-cis4u', TEAM)).toBe(true);
    expect(teamOwnsAnyFile(rules, ['src/A.java'], 'dedalus-cis4u', TEAM)).toBe(false);
    expect(teamOwnsAnyFile(rules, ['pom.xml'], 'other-org', TEAM)).toBe(false);
    expect(teamOwnsAnyFile([], ['pom.xml'], 'dedalus-cis4u', TEAM)).toBe(false);
  });
});
