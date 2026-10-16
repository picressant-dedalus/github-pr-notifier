# GitHub PR Notifier

Chrome-only Manifest V3 extension. It lists the open (non-draft) pull requests of configured
GitHub repositories in a popup and shows their count on the toolbar badge. `README.md` is the full
functional and technical reference; keep it in sync with any behaviour change.

## Commands

- Install dev deps: `npm install` (the shipped extension has no runtime dependencies)
- All unit tests: `npm test`. Single file: `npx jest test/github.test.js`. By name: `npx jest -t "admins flag"`
- Regenerate icons (`img/icon*.png`, `js/icons.js`) from `@primer/octicons`: `npm run icons`
- Package: `./build.sh` → `dist/chrome.zip` (only `css img js manifest.json *.html`)
- Real-browser smoke test (real GitHub API, writes `docs/screenshots/*.png`, git-ignored because they contain internal PR data, never commit them):
  `GITHUB_TOKEN=… E2E_REPOS="orme-pharmacy" CHROME_PATH=/usr/sbin/google-chrome npm run e2e`.
  Chrome ≥ 137 requires `--disable-features=DisableLoadExtensionCommandLineSwitch` for
  `--load-extension`, and puppeteer's `enableExtensions` (CDP `Extensions.loadUnpacked`) is
  unavailable on Chrome 138, so the script uses the flag approach.

## Architecture

- `js/background.js`: service worker wiring only (onInstalled/onStartup/alarms/storage change/
  `{type:'refresh'}` message). Logic lives in `js/poller.js` (`refreshAll` with a shared in-flight
  promise, `computeBadge`, `updateBadge`, `scheduleRefresh`). Use `chrome.alarms`, never `setInterval`,
  in the worker.
- `js/github.js`: per repo, **one paginated GraphQL query plus one REST call** run in parallel.
  The REST call `GET /pulls` exists because GraphQL `Team` fields (slug/name/id) need `read:org`,
  while REST `requested_teams[].slug` works with `repo` only. The target is a classic PAT with
  `repo` scope only; do not add GraphQL fields that need extra scopes.
  - GraphQL returns **partial `NOT_FOUND` errors** for missing CODEOWNERS locations (aliases
    `co0..co2` on `baseRef.target`). Only errors with no path or path length ≤ 1 are fatal.
  - Mapping helpers (`checkState`, `automergeState`, `adminsFlagState`, `mapPullRequest`,
    `formatDuration`) are pure; keep them that way for tests.
- Admin flag (`adminsReview`): `'pending'` if the team slug is in requested teams; `'reviewed'` if
  CODEOWNERS of the base branch gives a changed file (first 100) to `@org/team`; otherwise `null`.
  `js/codeowners.js` implements GitHub CODEOWNERS matching: last matching rule wins, and `dir/*`
  does not match nested files.
- `js/settings.js`: `settings` and `state` keys in `chrome.storage.local`. `normalizeSettings`
  supplies defaults (org `dedalus-cis4u`, refresh 5 min, team `cis4u-r-d-orbis-medication-admins`).
  `parseReposDetailed` (→ `{ repos, invalid }`, `parseRepos` = repos only) accepts names, `owner/name`, GitHub URLs (query/fragment stripped) and `git@` URLs, separated by new lines, spaces, commas or `;`; bullets and `#` comments are ignored. Invalid entries must never be dropped silently: the options page lists them and refuses to save. Repos are stored as `owner/name`.
- Popup: `js/popup-view.js` is pure DOM rendering (no `chrome.*`), and `js/popup.js` is the glue.
  Options: `js/options.js` exports `initOptions`/`runConnectionTest`. Both auto-init only when
  `document.body.dataset.page` matches (`popup`/`options`), so tests can import them safely.
- On refresh, a per-repo failure keeps the previous PRs and stores `error`. The badge is neutral
  grey (`#57606a`) with the count, `''` when 0, and red `!` only when no PR at all loaded and there are errors.
- `settings.badgeMinAgeDays` (default 0 = all) filters the toolbar counter (`isOldEnough` in
  `poller.js`). In the popup it adds the `.filters` bar (`all` | `old`, `FILTER_ALL`/`FILTER_OLD` in
  `popup-view.js`; the choice is stored under `popupFilter` in `chrome.storage.local` by `popup.js`)
  and marks old cards with `.pr-old`. With 0 there is no filter bar and every PR is listed. The badge is recomputed at each refresh, so a PR
  crossing the threshold is counted at the next refresh.

## Conventions

- Plain ES modules, no bundler/transpiler at runtime. Babel exists only for Jest
  (`babel.config.js`; do not add `"type": "module"` to package.json, because it breaks the CJS babel config/Jest).
- Insert GitHub data into the DOM with `textContent`/attributes only. `innerHTML` is reserved for
  the trusted generated `ICONS` constants. Links use `target="_blank" rel="noopener noreferrer"`.
- `js/icons.js` is generated; edit `scripts/generate-icons.mjs` instead.
- Tests: `test/setup.js` (registered with `setupFilesAfterEnv`) installs a fresh in-memory `chrome`
  mock and `global.fetch = jest.fn()` before each test. `test/helpers.js` has `jsonResponse`,
  `prNode`, `graphqlPage`, and `mockFetch({graphql, rest})` fixtures. The options test loads the real
  `options.html`.
- UI decisions confirmed with the user: drafts hidden, neutral badge color, no desktop
  notifications, Chrome only, green automerge badge only for the REBASE method.
- Commits: Conventional Commits (`feat(popup): …`), no `Co-authored-by` trailer.
