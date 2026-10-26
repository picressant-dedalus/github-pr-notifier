// Helpers to build fake GitHub API responses.
export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (h.has(name.toLowerCase()) ? h.get(name.toLowerCase()) : null) },
    json: async () => body
  };
}

export const CODEOWNERS = `# admins own the .github folder
/.github/ @dedalus-cis4u/cis4u-r-d-orbis-medication-admins
pom.xml @dedalus-cis4u/cis4u-r-d-orbis-medication-admins @picressant-dedalus
Jenkinsfile* @dedalus-cis4u/cis4u-r-d-orbis-medication-admins
`;

export function prNode(overrides = {}) {
  return {
    id: 'PR_node1',
    number: 1,
    title: 'feat: something',
    url: 'https://github.com/dedalus-cis4u/repo/pull/1',
    isDraft: false,
    createdAt: '2026-10-13T21:08:22Z',
    baseRefName: 'main/develop',
    reviewDecision: 'REVIEW_REQUIRED',
    author: { login: 'jdoe', avatarUrl: 'https://avatars/jdoe', url: 'https://github.com/jdoe' },
    autoMergeRequest: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    files: { totalCount: 1, nodes: [{ path: 'src/main/App.java' }] },
    baseRef: { target: { co0: { object: { text: CODEOWNERS } }, co1: null, co2: null } },
    ...overrides
  };
}

export function graphqlPage(nodes, { hasNextPage = false, endCursor = null, errors } = {}) {
  return { data: { repository: { pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } } }, ...(errors ? { errors } : {}) };
}

/** Routes fetch calls: GraphQL POST -> graphql(), REST GET -> rest(url). */
export function mockFetch({ graphql, rest }) {
  global.fetch.mockImplementation(async (url, init = {}) => {
    if (url.endsWith('/graphql')) return graphql(JSON.parse(init.body));
    return rest(url);
  });
}
