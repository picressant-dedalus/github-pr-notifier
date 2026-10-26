import {
  adminsFlagState, automergeState, checkState, fetchRepoPullRequests, formatDuration,
  mapPullRequest, testToken, checkRepoAccess, enableAutoMergeRebase, fetchApprovalCandidate, approvePullRequest
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

describe('enableAutoMergeRebase', () => {
  it('skips rebase PRs, switches other methods, collects failures', async () => {
    const queries = [];
    global.fetch.mockImplementation(async (url, init) => {
      const { query, variables } = JSON.parse(init.body);
      queries.push(`${query.match(/(\w+PullRequestAutoMerge)/)[1]}:${variables.id}`);
      if (variables.id === 'bad') return jsonResponse({ data: null, errors: [{ message: 'Auto merge is not allowed' }] });
      return jsonResponse({ data: {} });
    });

    const res = await enableAutoMergeRebase('t', [
      { repo: 'o/r', number: 1, nodeId: 'a', automerge: { enabled: true, rebase: true } },
      { repo: 'o/r', number: 2, nodeId: 'b', automerge: { enabled: true, rebase: false } },
      { repo: 'o/r', number: 3, nodeId: 'c', automerge: { enabled: false, rebase: false } },
      { repo: 'o/r', number: 4, nodeId: 'bad', automerge: { enabled: false, rebase: false } }
    ]);
    expect(queries).toEqual(['disablePullRequestAutoMerge:b', 'enablePullRequestAutoMerge:b', 'enablePullRequestAutoMerge:c', 'enablePullRequestAutoMerge:bad']);
    expect(res).toEqual({ done: 2, failed: [{ repo: 'o/r', number: 4, error: 'Auto merge is not allowed' }] });
  });
});

describe('approval eligibility', () => {
  const target = { repo: 'o/r', number: 7 };
  const metadata = {
    state: 'open', draft: false, title: 'A PR', html_url: 'https://github.com/o/r/pull/7',
    user: { login: 'author' }, base: { ref: 'main' }, head: { sha: 'abc' }
  };
  const review = (state, login = 'me') => ({ state, user: { login } });

  it.each([
    [[review('APPROVED'), review('COMMENTED'), review('PENDING')], false],
    [[review('DISMISSED')], true],
    [[review('APPROVED'), review('CHANGES_REQUESTED')], true],
    [[review('APPROVED', 'someone-else')], true]
  ])('uses the latest opinionated review in %j', async (reviews, eligible) => {
    global.fetch.mockResolvedValueOnce(jsonResponse(metadata)).mockResolvedValueOnce(jsonResponse(reviews));
    expect(await fetchApprovalCandidate('t', target, 'ME')).toMatchObject({ eligible, headSha: 'abc' });
  });

  it('reads later review pages before deciding', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(metadata))
      .mockResolvedValueOnce(jsonResponse(Array.from({ length: 100 }, () => review('COMMENTED'))))
      .mockResolvedValueOnce(jsonResponse([review('APPROVED')]));
    expect(await fetchApprovalCandidate('t', target, 'me')).toMatchObject({ eligible: false, reason: 'Already approved by you' });
    expect(global.fetch.mock.calls[2][0]).toContain('page=2');
  });

  it.each([
    [{ user: { login: 'Me' } }, 'own PR'],
    [{ state: 'closed' }, 'Not an open'],
    [{ draft: true }, 'Not an open']
  ])('disables ineligible metadata %j without reading reviews', async (overrides, reason) => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ ...metadata, ...overrides }));
    expect(await fetchApprovalCandidate('t', target, 'me')).toMatchObject({ eligible: false, reason: expect.stringContaining(reason) });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not silently accept missing metadata or review lookup errors', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ ...metadata, head: null }));
    await expect(fetchApprovalCandidate('t', target, 'me')).rejects.toThrow('head commit');
    global.fetch.mockResolvedValueOnce(jsonResponse(metadata))
      .mockResolvedValueOnce(jsonResponse({ message: 'Forbidden' }, { status: 403 }));
    await expect(fetchApprovalCandidate('t', target, 'me')).rejects.toThrow('403');
  });

  it('sends an authenticated, head-bound approval without a comment', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ state: 'APPROVED' }));
    await approvePullRequest('t', { ...target, headSha: 'abc' });
    expect(global.fetch).toHaveBeenCalledWith('https://api.github.com/repos/o/r/pulls/7/reviews', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'bearer t' }),
      body: JSON.stringify({ event: 'APPROVE', commit_id: 'abc' })
    }));
  });

  it.each([401, 403, 422])('surfaces approval HTTP %s errors', async (status) => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ message: 'Review rejected' }, { status }));
    await expect(approvePullRequest('t', { ...target, headSha: 'abc' })).rejects.toThrow();
  });
});
