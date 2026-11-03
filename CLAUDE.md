# Claude Code

Follow [AGENTS.md](AGENTS.md). Additionally:

- Create task worktrees only at `.claude/worktrees/<task-name>` inside this repository
  (`git worktree add .claude/worktrees/<task-name> -b <branch> origin/main`).
  Never create sibling folders such as `../unified-proxy-<task>`; the directory is gitignored.
