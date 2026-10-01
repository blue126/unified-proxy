# Git and Pull Request Workflow

- After this migration, `origin/main` is the source of truth for the project.
- Never develop, commit, or push directly on `main` or `master`.
- Start every task from the latest remote default branch in a unique branch and worktree. Do not switch or modify the user's existing checkout.
- Before editing, inspect the current branch, dirty state, upstream, and existing worktrees. Preserve all user changes; do not stash, reset, clean, overwrite, or commit them.
- Complete work in this order: validate, commit, push the task branch, then open a Draft PR.
- Explicit user instructions in the current session take precedence over these workflow defaults.
- Agents may merge a PR only when the user explicitly authorizes that merge in the current session and validation for the current PR head has passed. Marking an authorized Draft PR ready for merge is allowed. Without explicit merge authorization, leave the PR as a Draft.
- When the user explicitly requests cleanup, agents may delete this task's local and remote branches and its worktree after confirming that the PR is merged, every task commit is integrated into the remote default branch, and the worktree has no uncommitted, untracked, or needed ignored files. Do not force removal or delete another task's branch, worktree, or the user's primary checkout.
- An explicit request such as "merge, clean up, and finish" authorizes both the merge and this task's post-merge branch/worktree cleanup; do not ask again for those actions once the checks above pass.
- Agents must never close PRs without merging, force-push, or rewrite history.
- Before merging, inspect and report any production effects of existing merge-triggered workflows. An explicitly authorized merge may trigger those existing workflows, including automatic deployment. Additional manual deployment, publishing, releases, image pushes, production configuration changes, or production-secret access still require a separate explicit user request.

## Validation

- Run `npm test` for the repository's side-effect-free unit test suite.
- `npm run test:integration` starts an integration server and can exercise configured provider credentials; use it only when the task requires integration coverage.
- `npm run smoke` performs live inference against configured upstream services and is not routine PR validation.
- `.github/workflows/deploy.yml` deploys on pushes to `main`; agents must not trigger it by pushing directly to `main`.
