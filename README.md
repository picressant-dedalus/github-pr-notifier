# GitHub PR Notifier

A Chrome extension (Manifest V3) that lists the **open pull requests** of a set of GitHub
repositories and shows the **number of waiting PRs** on the toolbar icon.

Built for the `dedalus-cis4u` organisation (ORBIS Medication repositories) but works with any
organisation. Inspired by
[another-modern-jenkins-notifier](../another-modern-jenkins-notifier).

> This project was entirely "vibe-coded" with GitHub Copilot CLI. This README is the reference for
> both users and future contributors (human or AI); `.github/copilot-instructions.md` holds the
> condensed agent context.

## Features

- **Toolbar badge**: GitHub icon with the number of open, non-draft PRs across all configured
  repositories. Optionally only PRs older than *N* days are counted (setting
  *Count PRs older than*). It is hidden when 0, and shows `!` in red when nothing could be loaded. The tooltip
  shows the count per repository.
- **Popup**: one collapsible section per repository (in the configured order), with a card per
  pull request showing:

  | Element | Meaning |
  |---|---|
  | Title (link) | Opens the PR on GitHub |
  | Avatar + login | Author of the PR |
  | `#978` | PR number |
  | 🕒 `1d 17h` | Time since the PR was created (`m`, `h`, `d`, `mo`, `y`) |
  | Grey badge | Target (base) branch |
  | Green **automerge** badge | Auto-merge is enabled with the **rebase** method |
  | Red **automerge** badge | Auto-merge disabled, or enabled with another method (merge/squash) — see tooltip |
  | ✅ green tick | All checks passed |
  | 🟠 orange dot | Checks in progress / expected |
  | ❌ red cross | At least one check failed |
  | grey dot | No checks on the last commit |
  | 🚩 red flag | A review from **@dedalus-cis4u/cis4u-r-d-orbis-medication-admins** is mandatory and **still pending** |
  | 🚩 green flag | A review from that team is mandatory and **has already been done** |

- **Old pull requests**: when *Count PRs older than* is set (> 0), PRs older than that are
  highlighted (orange left border and age), and a filter bar appears at the top of the popup:
  **All (N)** / **Older than Xd (M)**. The second tab lists only the PRs counted on the toolbar badge,
  hides repositories without any (except those in error), and the selected tab is remembered.

- Draft PRs are hidden and not counted.
- Automatic refresh every 5 minutes (configurable), plus a manual refresh button.
- **Enable auto-merge (rebase) on all listed PRs**: merge-icon button in the popup header. After a
  confirmation, it targets the PRs currently visible (respecting the old/all filter) that are not
  already on rebase auto-merge. PRs with auto-merge on another method are switched (disable, then
  enable) using the GraphQL `enablePullRequestAutoMerge`/`disablePullRequestAutoMerge` mutations
  (`repo` scope is enough, via the `{type:'enable-automerge'}` worker message). Per-PR failures
  (e.g. repo without "Allow auto-merge") are listed in the popup, then data is refreshed.
- **Approve selected PRs**: check-icon button beside auto-merge opens a modal for PRs matching
  the current All/Older filter. Nothing is selected initially; choose individual PRs or
  **Select all eligible PRs**, then **Approve selected**. This immediately submits normal
  approvals as the configured token's user, without a comment or another confirmation.
  Your own PRs, PRs you already approved, and PRs whose eligibility cannot be checked are
  disabled with a reason. Closed/draft PRs are also excluded from submission.
  Approval does not enable auto-merge or bypass GitHub permissions or branch protection, but
  **can allow PRs with auto-merge already enabled to merge**.
  Each PR is checked again before submission; changed head commits are skipped rather than
  silently approving new code. Progress and per-PR results survive popup closure; reopening
  shows a summary and the approval button opens the saved results. **New selection** starts
  again with the current filter, while **Recheck unsuccessful PRs** checks only unsuccessful
  targets and starts with nothing selected. Successful targets are never automatically retried.
  Closing the modal is not cancellation of a submitted batch. Browser/worker interruption or
  a lost write response can leave an **uncertain** result: check GitHub before explicitly
  rechecking/retrying. Uncertain writes are never replayed automatically.
- If a repository fails to load (wrong name, no access, SSO…) the error is shown in its section,
  and the last known PRs are kept.

## Installation (unpacked)

1. Clone/copy this folder.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select this folder (or unzip `dist/chrome.zip` built by
   `./build.sh` and select it).
4. Pin the extension to the toolbar, then open its **Options** (right-click the icon → Options,
   or the ⚙ button in the popup).

## Settings

| Setting | Default | Description |
|---|---|---|
| Organisation | `dedalus-cis4u` | Used for repositories given by name only |
| Repositories | – | One per line (spaces, commas or `;` also separate entries): `orme-pharmacy`, `owner/name`, `https://github.com/owner/name` (any sub-path, `?query` or `#anchor` is ignored) or `git@github.com:owner/name.git`. Bullets (`-`, `*`) and `#` comments are ignored. Unrecognised entries are listed under the field and **block the save**, so no repository is silently dropped |
| Token | – | GitHub personal access token (see below) |
| Refresh interval | `5` | Minutes between automatic refreshes (minimum 1) |
| Count PRs older than (days) | `0` | The toolbar counter only counts PRs created at least this many days ago. `0` counts all PRs. The popup always lists every PR |
| Mandatory reviewer team | `cis4u-r-d-orbis-medication-admins` | Team slug (as in CODEOWNERS, without `@org/`) used for the flag. Empty = no flag |

**Test connection** validates the token and checks the access to every listed repository.

### GitHub token

Create a **classic** personal access token with the **`repo`** scope:
<https://github.com/settings/tokens/new?scopes=repo&description=GitHub%20PR%20Notifier>

Then, on the token list, click **Configure SSO → Authorize** next to `dedalus-cis4u`, otherwise
GitHub answers 403 and the popup shows an SSO error.

`read:org` is **not** required. A fine-grained token also works if it gives read access to
*Pull requests*, *Contents*, *Commit statuses* and *Checks* (*Metadata* is implied) on the
repositories.

For **approving PRs**, a fine-grained token additionally needs **Pull requests: write** on the
target repositories. The token's user must have permission to approve; GitHub does not permit
self-approval. The classic `repo` scope already covers this.

The token is stored in `chrome.storage.local` (this browser profile only, never synced) and is
only sent to `https://api.github.com`.

## How it works

### Data fetched per repository (2 requests in parallel per refresh)

1. **GraphQL** `POST /graphql` (`PULL_REQUESTS_QUERY` in `js/github.js`), paginated by 50 PRs:
   title, url, draft flag, creation date, base branch, author, `autoMergeRequest.mergeMethod`,
   `statusCheckRollup.state` of the last commit, the first 100 changed files, and the CODEOWNERS
   file of the base branch (`.github/CODEOWNERS`, `CODEOWNERS` or `docs/CODEOWNERS`, the same lookup
   order as GitHub).
2. **REST** `GET /repos/{owner}/{repo}/pulls?state=open` to read `requested_teams[].slug`.
   GraphQL `Team` fields would require the `read:org` scope; the REST endpoint only needs `repo`.

### Mandatory admin review flag

GitHub has no "required reviewer" field on a PR. The team is mandatory when it is a code
owner of a changed file and the branch protection requires code owner reviews (true for the ORME
repositories). The extension derives the flag as follows:

- **pending (red)**: the team is currently in the PR's requested reviewers.
- **reviewed (green)**: the team is no longer requested, but CODEOWNERS of the base branch assigns
  at least one changed file to `@org/team` (GitHub removes the team request once a member reviews
  on its behalf).
- **none**: otherwise.

CODEOWNERS matching (`js/codeowners.js`) follows GitHub's rules: gitignore-like patterns, and the
last matching line wins. Limitation: only the first 100 changed files are checked for the
"reviewed" state (the "pending" state is always exact).

### Selective approvals

Approval eligibility is fetched only on demand, leaving the scheduled refresh requests unchanged:
`GET /user` resolves the token user, then `GET /repos/{owner}/{repo}/pulls/{number}` and paginated
`GET .../reviews` determine fresh metadata and the user's latest opinionated review.
Comments/pending reviews do not replace an existing approval; dismissed approvals do not count.
The worker rechecks eligibility and the selected head before each sequential
`POST .../reviews` with `{event: "APPROVE", commit_id: "<selected head>"}`.
Per-PR failures do not stop the remaining targets.

`js/approvals.js` owns the `prepare-approvals`, `submit-approvals`, and `approval-status` workflow.
Prepared selections (`approvalSelection`) are single-use, and the latest batch (`approvalBatch`)
stores per-target progress/results separately from refresh state in `chrome.storage.local`.
No extra token copy is stored. Overlapping submissions are rejected. Interrupted batches are
reported rather than resumed automatically; rechecking consults GitHub before a manual retry.
After processing, cached PR data/badges are refreshed; refresh errors do not erase approval results.

### Badge and refresh

The MV3 service worker (`js/background.js`) schedules a `chrome.alarms` alarm every *N* minutes
and refreshes all repositories in parallel (`refreshAll` in `js/poller.js`). It also refreshes
when settings change or when the popup's refresh button is clicked. Results are stored in
`chrome.storage.local` (`state` key). The popup only reads that state and re-renders when it
changes.

## Project structure

```
manifest.json          MV3 manifest (permissions: storage, alarms; host: api.github.com)
popup.html             Toolbar popup
options.html           Settings page (opens in a tab)
css/                   common.css (Primer-like palette), popup.css, options.css
img/                   Toolbar/store icons (generated)
js/
  background.js        Service worker: events → poller
  poller.js            refreshAll(), computeBadge(), updateBadge(), scheduleRefresh()
  approvals.js         Worker-owned approval preparation, execution and durable results
  github.js            GitHub API client + pure mapping (checks, automerge, flag, durations)
  codeowners.js        CODEOWNERS parser/matcher
  settings.js          Settings/state persistence, repository list parsing
  popup-view.js        Pure DOM rendering of the popup (unit-tested)
  popup.js             Popup glue (storage, refresh button, timers)
  options.js           Settings page logic + connection test
  icons.js             GENERATED inline SVG octicons
scripts/
  generate-icons.mjs   Builds img/icon*.png and js/icons.js from @primer/octicons
  e2e.mjs              Real-Chrome smoke test with the real GitHub API
test/                  Jest unit tests (jsdom) + chrome mock (setup.js) + fixtures (helpers.js)
build.sh               Packages dist/chrome.zip
```

## Development

```bash
npm install            # dev dependencies only — the extension itself has no runtime dependency
npm test               # Jest unit tests
npm run test:coverage
npm run icons          # regenerate img/*.png and js/icons.js
./build.sh             # dist/chrome.zip
GITHUB_TOKEN=ghp_xxx E2E_REPOS="orme-pharmacy,orme-pharmacy-surveillance" [E2E_MIN_AGE_DAYS=2] \
  CHROME_PATH=/usr/bin/google-chrome npm run e2e   # end-to-end smoke test + local screenshots (git-ignored: they contain internal PR data)
```

After changing code, click the reload icon of the extension in `chrome://extensions`. To debug the
service worker, click its **service worker** link on that page.

## Credits

Icons: [GitHub Octicons](https://github.com/primer/octicons) (MIT License).
