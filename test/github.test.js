import {
  adminsFlagState, automergeState, checkState, fetchRepoPullRequests, formatDuration,
  mapPullRequest, testToken, checkRepoAccess
} from '../js/github.js';
import { CODEOWNERS, graphqlPage, jsonResponse, mockFetch, prNode } from './helpers.js';

const TEAM = 'cis4u-r-d-orbis-medication-admins';
const ORG = 'dedalus-cis4u';

describe('checkState', () => {
  it.each([
    ['SUCCESS', 'success'], ['PENDING', 'pending'], ['EXPECTED', 'pending'],
    ['FAILURE', 'failure'], ['ERROR', 'failure'], [null, 'none'], [undefined, 'none']
  ])('%s -> %s', (input, expected) => expect(checkState(input)).toBe(expected));
});

describe('automergeState', () => {
  it('is green only for rebase', () => {
    expect(automergeState({ mergeMethod: 'REBASE' })).toEqual({ enabled: true, method: 'REBASE', rebase: true });
    expect(automergeState({ mergeMethod: 'SQUASH' })).toEqual({ enabled: true, method: 'SQUASH', rebase: false });
    expect(automergeState(null)).toEqual({ enabled: false, method: null, rebase: false });
  });
});

describe('adminsFlagState', () => {
  const base = { org: ORG, teamSlug: TEAM, codeowners: CODEOWNERS };
  it('is pending when the team review is requested', () => {
    expect(adminsFlagState({ ...base, requestedTeams: [TEAM], files: [] })).toBe('pending');
  });
  it('is reviewed when CODEOWNERS requires the team but it is no longer requested', () => {
    expect(adminsFlagState({ ...base, requestedTeams: [], files: ['.github/workflows/a.yml'] })).toBe('reviewed');
  });
  it('is null when the team owns none of the files', () => {
    expect(adminsFlagState({ ...base, requestedTeams: ['other'], files: ['src/A.java'] })).toBeNull();
  });
  it('is null when no team is configured', () => {
    expect(adminsFlagState({ ...base, teamSlug: '', requestedTeams: [TEAM] })).toBeNull();
  });
});

describe('mapPullRequest', () => {
  it('maps a GraphQL node', () => {
    const pr = mapPullRequest(prNode({ autoMergeRequest: { mergeMethod: 'REBASE' }, files: { nodes: [{ path: 'pom.xml' }] } }),
      { requestedTeams: [], org: ORG, teamSlug: TEAM });
    expect(pr).toMatchObject({
      number: 1, title: 'feat: something', baseRefName: 'main/develop', checks: 'success',
      author: { login: 'jdoe' }, automerge: { rebase: true }, adminsReview: 'reviewed'
    });
  });
  it('handles deleted authors and missing CODEOWNERS / checks', () => {
    const pr = mapPullRequest(prNode({ author: null, baseRef: null, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }),
      { org: ORG, teamSlug: TEAM });
    expect(pr.author.login).toBe('ghost');
    expect(pr.checks).toBe('none');
    expect(pr.adminsReview).toBeNull();
  });
});

describe('fetchRepoPullRequests', () => {
  it('combines GraphQL and REST data, paginates and hides drafts', async () => {
    const graphqlCalls = [];
    mockFetch({
      graphql: (body) => {
        graphqlCalls.push(body.variables);
        if (!body.variables.after) {
          return jsonResponse(graphqlPage([prNode({ number: 3 }), prNode({ number: 2, isDraft: true })], { hasNextPage: true, endCursor: 'c1' }));
        }
        // partial NOT_FOUND errors for missing CODEOWNERS locations must be tolerated
        return jsonResponse(graphqlPage([prNode({ number: 1 })], {
          errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequests', 'nodes', 0, 'baseRef', 'target', 'co1'] }]
        }));
      },
      rest: () => jsonResponse([{ number: 3, requested_teams: [{ slug: TEAM }] }, { number: 1, requested_teams: [] }])
    });

    const prs = await fetchRepoPullRequests('tok', `${ORG}/repo`, TEAM);
    expect(prs.map((p) => p.number)).toEqual([3, 1]);
    expect(prs[0].adminsReview).toBe('pending');
    expect(prs[1].adminsReview).toBeNull();
    expect(graphqlCalls).toEqual([
      { owner: ORG, name: 'repo', first: 50, after: null },
      { owner: ORG, name: 'repo', first: 50, after: 'c1' }
    ]);
    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers.Authorization).toBe('bearer tok');
  });

  it('reports a missing repository', async () => {
    mockFetch({
      graphql: () => jsonResponse({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'] }] }),
      rest: () => jsonResponse({ message: 'Not Found' }, { status: 404 })
    });
    await expect(fetchRepoPullRequests('tok', `${ORG}/nope`, TEAM)).rejects.toThrow(`Repository ${ORG}/nope not found`);
  });

  it('reports an invalid token', async () => {
    mockFetch({ graphql: () => jsonResponse({ message: 'Bad credentials' }, { status: 401 }), rest: () => jsonResponse([], { status: 401 }) });
    await expect(fetchRepoPullRequests('bad', `${ORG}/repo`, TEAM)).rejects.toThrow('Invalid or expired GitHub token');
  });

  it('reports a token not authorised for SSO', async () => {
    const sso = { status: 403, headers: { 'X-GitHub-SSO': 'required; url=https://github.com/orgs/x/sso' } };
    mockFetch({ graphql: () => jsonResponse({ message: 'SSO' }, sso), rest: () => jsonResponse({ message: 'SSO' }, sso) });
    await expect(fetchRepoPullRequests('t', `${ORG}/repo`, TEAM)).rejects.toThrow(/SSO/);
  });
});

describe('testToken / checkRepoAccess', () => {
  it('returns login and scopes', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ login: 'me' }, { headers: { 'X-OAuth-Scopes': 'repo, read:org' } }));
    await expect(testToken('t')).resolves.toEqual({ login: 'me', scopes: ['repo', 'read:org'] });
  });
  it('rejects when a repo is not accessible', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ message: 'Not Found' }, { status: 404 }));
    await expect(checkRepoAccess('t', 'o/r')).rejects.toThrow('Repository o/r not found');
  });
});

describe('formatDuration', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  it.each([
    ['2026-10-15T11:59:30Z', '0m'],
    ['2026-10-15T11:15:00Z', '45m'],
    ['2026-10-15T06:48:00Z', '5h 12m'],
    ['2026-10-12T08:00:00Z', '3d 4h'],
    ['2026-08-10T12:00:00Z', '2mo 6d'],
    ['2024-09-15T12:00:00Z', '2y 1mo'],
    ['2026-10-16T12:00:00Z', '0m']
  ])('%s -> %s', (from, expected) => expect(formatDuration(from, now)).toBe(expected));
});
