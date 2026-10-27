---
name: publish-release
description: Rebuild the extension ZIP and publish a new GitHub release with an incremented version. Use when asked to publish or release this extension.
---

# Publish release

1. Inspect the worktree and existing GitHub releases/tags. Include only intended changes;
   never publish session transcripts, credentials, or internal screenshots.
2. Increment the last version component by one, for example `1.0.0` -> `1.0.1`
   (a patch increment in SemVer), unless the user specifies another version. Keep
   `manifest.json`, `package.json`, and the root versions in `package-lock.json` in sync.
   Never overwrite an existing version or release.
3. Keep `README.md` in sync with behaviour changes. Run `npm test -- --runInBand`
   and `git diff --check`; resolve failures before publishing.
4. Rebuild the archive with `./build.sh`. Check `dist/chrome.zip` integrity, its
   embedded manifest version, and that it contains only extension runtime files.
5. Commit the intended changes using Conventional Commits. This repository is exempt
   from mandatory ticket references. Do not add a `Co-authored-by` trailer.
6. Push the commit and create a GitHub release tagged `v<version>` targeting that exact
   commit. Summarize the user-visible changes and attach the rebuilt `dist/chrome.zip`.
   Use authenticated GitHub CLI or GitHub REST API requests; never print credentials.
7. Verify the published release's tag, target commit, and downloadable ZIP asset.
   Return the release link. If publication fails, report precisely which steps completed;
   do not claim the release was published.
