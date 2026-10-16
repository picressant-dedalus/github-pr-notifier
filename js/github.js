// GitHub API client + pure mapping helpers.
// Works with a token that only has the `repo` scope (classic PAT) — no `read:org` needed:
//   - GraphQL gives PR data, checks, auto-merge, changed files and the base branch CODEOWNERS;
//   - REST `GET /repos/{owner}/{repo}/pulls` gives `requested_teams[].slug` (GraphQL Team fields
//     would require `read:org`).

import { CODEOWNERS_PATHS, parseCodeowners, teamOwnsAnyFile } from './codeowners.js';

export const API_URL = 'https://api.github.com';
const PAGE_SIZE = 50;
const MAX_PAGES = 4;

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

const CODEOWNERS_FIELDS = CODEOWNERS_PATHS
  .map((path, i) => `co${i}: file(path: "${path}") { object { ... on Blob { text } } }`)
  .join('\n              ');

export const PULL_REQUESTS_QUERY = `
query PullRequests($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        url
        isDraft
        createdAt
        baseRefName
        reviewDecision
        author { login avatarUrl url }
        autoMergeRequest { mergeMethod enabledAt }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        files(first: 100) { totalCount nodes { path } }
        baseRef {
          target {
            ... on Commit {
              ${CODEOWNERS_FIELDS}
            }
          }
        }
      }
    }
  }
}`;

function headers(token) {
  return {
    Authorization: `bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

/** Converts a failed HTTP response into a user-friendly GitHubError. */
async function httpError(response, fullName) {
  let detail = '';
  try {
    detail = (await response.json()).message || '';
  } catch {
    // body is not JSON
  }
  const sso = response.headers.get('x-github-sso');
  if (response.status === 401) return new GitHubError('Invalid or expired GitHub token', 401);
  if (response.status === 403 && sso) {
    return new GitHubError('Token is not authorised for this organisation (SSO): open Settings > Tokens > Configure SSO', 403);
  }
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    return new GitHubError('GitHub API rate limit exceeded', 403);
  }
  if (response.status === 404) {
    const what = fullName ? `Repository ${fullName}` : 'Resource';
    return new GitHubError(`${what} not found or not accessible with this token`, 404);
  }
  return new GitHubError(`GitHub API error ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
}

async function graphql(token, query, variables, fullName) {
  const response = await fetch(`${API_URL}/graphql`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) throw await httpError(response, fullName);
  const body = await response.json();
  // Missing optional fields (e.g. absent CODEOWNERS locations) come back as partial NOT_FOUND
  // errors next to valid data: only errors that are not about a nested field are fatal.
  const fatal = (body.errors || []).filter((e) => !Array.isArray(e.path) || e.path.length <= 1);
  if (!body.data || fatal.length) {
    const first = fatal[0] || (body.errors || [])[0] || {};
    if (first.type === 'NOT_FOUND') {
      throw new GitHubError(`Repository ${fullName} not found or not accessible with this token`, 404);
    }
    throw new GitHubError(first.message || 'GitHub GraphQL error');
  }
  return body.data;
}

async function rest(token, path, fullName) {
  const response = await fetch(`${API_URL}${path}`, { headers: headers(token) });
  if (!response.ok) throw await httpError(response, fullName);
  return response.json();
}

/** Returns { [prNumber]: string[] } of team slugs whose review is currently requested. */
async function fetchRequestedTeams(token, fullName) {
  const result = {};
  for (let page = 1; page <= MAX_PAGES; page++) {
    const prs = await rest(token, `/repos/${fullName}/pulls?state=open&per_page=100&page=${page}`, fullName);
    for (const pr of prs) {
      result[pr.number] = (pr.requested_teams || []).map((t) => String(t.slug).toLowerCase());
    }
    if (prs.length < 100) break;
  }
  return result;
}

async function fetchPullRequestNodes(token, fullName) {
  const [owner, name] = fullName.split('/');
  const nodes = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(token, PULL_REQUESTS_QUERY, { owner, name, first: PAGE_SIZE, after }, fullName);
    if (!data.repository) {
      throw new GitHubError(`Repository ${fullName} not found or not accessible with this token`, 404);
    }
    const { nodes: pageNodes, pageInfo } = data.repository.pullRequests;
    nodes.push(...pageNodes);
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return nodes;
}

/** Maps the rollup state of the last commit to 'success' | 'pending' | 'failure' | 'none'. */
export function checkState(rollupState) {
  switch (rollupState) {
    case 'SUCCESS':
      return 'success';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    default:
      return 'none';
  }
}

/**
 * Auto-merge status: { enabled, method, rebase }.
 * The UI shows a green badge only when auto-merge is enabled with the REBASE method.
 */
export function automergeState(autoMergeRequest) {
  const method = autoMergeRequest ? autoMergeRequest.mergeMethod : null;
  return { enabled: Boolean(method), method, rebase: method === 'REBASE' };
}

function codeownersText(baseRef) {
  const target = baseRef && baseRef.target;
  if (!target) return '';
  for (let i = 0; i < CODEOWNERS_PATHS.length; i++) {
    const entry = target[`co${i}`];
    if (entry && entry.object && typeof entry.object.text === 'string') return entry.object.text;
  }
  return '';
}

/**
 * Admin team review state:
 *   'pending'  - the team review is currently requested (not done yet)
 *   'reviewed' - the team owns changed files (CODEOWNERS) but is no longer requested, i.e. a
 *                member already reviewed on behalf of the team
 *   null       - no review needed from the team
 */
export function adminsFlagState({ requestedTeams = [], files = [], codeowners = '', org, teamSlug }) {
  if (!teamSlug) return null;
  const slug = teamSlug.toLowerCase();
  if (requestedTeams.includes(slug)) return 'pending';
  if (teamOwnsAnyFile(parseCodeowners(codeowners), files, org, slug)) return 'reviewed';
  return null;
}

/** Converts a GraphQL PR node to the compact object stored and rendered by the extension. */
export function mapPullRequest(node, { requestedTeams = [], org, teamSlug } = {}) {
  const commit = node.commits && node.commits.nodes[0] && node.commits.nodes[0].commit;
  const rollup = commit && commit.statusCheckRollup ? commit.statusCheckRollup.state : null;
  const files = node.files ? node.files.nodes.map((f) => f.path) : [];
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    isDraft: Boolean(node.isDraft),
    createdAt: node.createdAt,
    baseRefName: node.baseRefName,
    reviewDecision: node.reviewDecision || null,
    author: node.author
      ? { login: node.author.login, avatarUrl: node.author.avatarUrl, url: node.author.url }
      : { login: 'ghost', avatarUrl: '', url: '' },
    checks: checkState(rollup),
    automerge: automergeState(node.autoMergeRequest),
    adminsReview: adminsFlagState({
      requestedTeams,
      files,
      codeowners: codeownersText(node.baseRef),
      org,
      teamSlug
    })
  };
}

/**
 * Fetches the open, non-draft pull requests of a repository ("owner/name").
 * @returns {Promise<object[]>} mapped pull requests, newest first
 */
export async function fetchRepoPullRequests(token, fullName, teamSlug) {
  const org = fullName.split('/')[0];
  const [nodes, requested] = await Promise.all([
    fetchPullRequestNodes(token, fullName),
    fetchRequestedTeams(token, fullName)
  ]);
  return nodes
    .filter((node) => !node.isDraft)
    .map((node) => mapPullRequest(node, { requestedTeams: requested[node.number] || [], org, teamSlug }));
}

/** Validates the token; returns the authenticated login and granted scopes. */
export async function testToken(token) {
  const response = await fetch(`${API_URL}/user`, { headers: headers(token) });
  if (!response.ok) throw await httpError(response);
  const user = await response.json();
  const scopes = (response.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { login: user.login, scopes };
}

/** Checks the token can read the pull requests of a repository; resolves or throws GitHubError. */
export async function checkRepoAccess(token, fullName) {
  await rest(token, `/repos/${fullName}/pulls?state=open&per_page=1`, fullName);
}

/** Human readable age, e.g. "45m", "5h 12m", "3d 4h", "2mo 3d". */
export function formatDuration(fromIso, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ${hours % 24}h`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ${days % 30}d`;
  return `${Math.floor(days / 365)}y ${Math.floor((days % 365) / 30)}mo`;
}
