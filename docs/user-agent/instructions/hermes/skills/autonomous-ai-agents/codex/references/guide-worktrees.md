## Brai DEV workflow

For Brai DEV, follow the repository `AGENTS.md` and use the accepted DEV manifest as the candidate baseline; the Git branch tip alone does not prove what is installed. The agent performs these steps without asking the user to prepare the workspace:

1. Create an isolated Git worktree and a task branch using Codex when available, or Git. Keep existing worktrees and other people's changes intact.
2. Prepare a new worktree with `brai-worktree-prepare <absolute-worktree-path>`. Preserve personal data and existing worktree dependencies.
3. Make the task changes, run the relevant code and contract checks, and create a clean commit. An ordinary release checks affected code and contracts; it does not scan personal profiles or rebuild the platform when dependencies are unchanged.
4. Release the exact clean commit with `brai-dev release --source <full-commit-sha>`. Use `brai-dev status [<operation-id>]` to inspect the same operation, especially if its response is lost; do not repeat side effects blindly.
5. Push the task changes as required by the repository. A pull request and remote CI are not prerequisites for a DEV release. GitHub unavailability does not block the local release; report any unsent commit as pending.
6. After the release is accepted and changes are pushed, safely clean up only your own completed clean worktree. Preserve uncommitted, untracked, ignored, personal and other people's data; if ownership or safety is unclear, keep the worktree and report why. Do not delete remote branches without separate authorization.

An accepted release records the desired composition. Loaded profiles may finish their current turns before switching; inspect `nativeProgress` in status, preserve pending turns, and never pause a profile to speed up a release. If status reports an operation blocked, inspect that same operation and use `brai-dev reconcile <original-program-operation-id>` only for that reported blockage. A later instructions release can have a different operation ID; do not reconcile it in place of the original program operation or launch another release blindly.

Keep protected system instructions separate from personal settings. Do not edit a user's personal settings to fix system instructions.

PROD changes require a separate explicit request. The full release time has not yet been established; do not promise a 120-second result without measurement on a real task.

## Parallel Issue Fixing with Worktrees

Follow the repository instructions for preparing a worktree and its dependencies before using the commands below.

```
# Create worktrees
terminal(command="git worktree add -b fix/issue-78 ~/.hermes/cache/scratch/issue-78 main", workdir="~/project")
terminal(command="git worktree add -b fix/issue-99 ~/.hermes/cache/scratch/issue-99 main", workdir="~/project")

# Launch Codex in each
terminal(command="codex --sandbox workspace-write exec 'Fix issue #78: <description>. Commit when done.'", workdir="~/.hermes/cache/scratch/issue-78", background=true, pty=true)
terminal(command="codex --sandbox workspace-write exec 'Fix issue #99: <description>. Commit when done.'", workdir="~/.hermes/cache/scratch/issue-99", background=true, pty=true)

# Monitor
process(action="list")

# After completion, push and create PRs
terminal(command="cd ~/.hermes/cache/scratch/issue-78 && git push -u origin fix/issue-78")
terminal(command="gh pr create --repo user/repo --head fix/issue-78 --title 'fix: ...' --body '...'")

# Cleanup
terminal(command="git worktree remove ~/.hermes/cache/scratch/issue-78", workdir="~/project")
```

