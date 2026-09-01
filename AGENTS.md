# Git and Pull Request Workflow

- After this migration, `origin/main` is the source of truth for the project.
- Never develop, commit, or push directly on `main` or `master`.
- Start every task from the latest remote default branch in a unique branch and worktree. Do not switch or modify the user's existing checkout.
- Before editing, inspect the current branch, dirty state, upstream, and existing worktrees. Preserve all user changes; do not stash, reset, clean, overwrite, or commit them.
- Complete work in this order: validate, commit, push the task branch, then open a Draft PR.
- Agents must never merge or close PRs, force-push, rewrite history, or delete branches or worktrees.
- Do not deploy, publish, release, push images, change production configuration, or access production secrets unless the user explicitly requests that separate action.

## Validation

- Run `npm test` for the repository's side-effect-free unit test suite.
- `npm run test:integration` starts an integration server and can exercise configured provider credentials; use it only when the task requires integration coverage.
- `npm run smoke` performs live inference against configured upstream services and is not routine PR validation.
- `.github/workflows/deploy.yml` deploys on pushes to `main`; agents must not trigger it by pushing directly to `main`.
