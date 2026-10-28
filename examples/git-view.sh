#!/bin/sh
# wag example: a live, read-only git view for a tmux pane, while your AI agent makes the changes and commits.
#
# Run it in a feature folder and it shows every repo of the feature; run it in one worktree and it shows that repo.
# For each repo: the branch and whether it is pushed, staged files (green) and not-staged files (red) with line
# counts, new files (??), whether origin's default branch has commits you have not merged yet, and the latest commits.
#
# Live without being jumpy: it checks every 2 seconds and redraws only when something changed, in place (no screen
# clearing), with long lines cut off instead of wrapped and the view cut to the pane's height, so nothing scrolls.
# It never takes git's index lock, so it cannot make your agent's git commands fail while it watches.
#
# Copy to ~/.config/wag/git-view.sh. Read full diffs in a terminal with git show / git diff (nicer with delta).
#
# Usage: git-view.sh [--once] [folder] [commits per repo]
#   --once   print the view one time and exit, instead of watching
#   commits  defaults to 8 for one repo and 3 per repo in a feature folder

export GIT_OPTIONAL_LOCKS=0   # read-only: never lock the index the agent is using

once=no
[ "$1" = "--once" ] && once=yes && shift
dir=${1:-.}
commits=$2

# One repo: branch line, files, line counts, unmerged commits on the default branch, latest commits.
show() {
  r=$1 n=$2
  # A branch that is not on origin yet has no upstream, so git prints the branch alone, with no "...origin/x".
  branch=$(git -C "$r" -c color.ui=always status --short --branch 2>/dev/null | head -n 1)
  case $branch in
    *'[gone]'*) branch=$(printf '%s' "$branch" | sed 's/\[gone\]/(not pushed yet)/') ;;
    *...* | *'(no branch)'*) ;;
    *) branch="$branch (not pushed yet)" ;;
  esac
  printf '%s\n' "$branch"
  git -C "$r" -c color.ui=always status --short 2>/dev/null
  staged=$(git -C "$r" diff --cached --shortstat 2>/dev/null)
  unstaged=$(git -C "$r" diff --shortstat 2>/dev/null)
  [ -n "$staged" ] && echo "   staged:$staged"
  [ -n "$unstaged" ] && echo "   not staged:$unstaged"
  base=$(git -C "$r" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
  if [ -n "$base" ]; then
    behind=$(git -C "$r" rev-list --count "HEAD..$base" 2>/dev/null)
    [ "${behind:-0}" -gt 0 ] && echo "   $base has $behind commit(s) to merge (as of the last fetch)"
  fi
  git -C "$r" -c color.ui=always log --oneline --decorate -n "$n" 2>/dev/null
}

render() {
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    show "$dir" "${commits:-8}"
    return
  fi
  first=yes
  for r in "$dir"/*/; do
    r=${r%/}
    [ -e "$r/.git" ] || continue
    [ "$first" = yes ] || echo
    first=no
    printf '\033[1m%s\033[0m\n' "$(basename "$r")"
    show "$r" "${commits:-3}"
  done
  [ "$first" = yes ] && echo "No git worktrees in $dir"
}

if [ "$once" = yes ]; then
  render
  exit 0
fi

# Draw in place: cursor home, each line followed by "clear to end of line", then "clear below".
# Line wrapping and the cursor are off while watching, and back on when it stops.
trap 'printf "\033[?7h\033[?25h"; exit 0' INT TERM HUP
printf '\033[?7l\033[?25l\033[H\033[2J'
last=
while :; do
  out=$(render 2>&1)
  if [ "$out" != "$last" ]; then
    rows=$(tput lines 2>/dev/null || echo 24)
    printf '\033[H'
    { printf '\033[2mgit view · green staged · red not staged · ?? new · %s\033[0m\n' "$(date +%H:%M:%S)"
      printf '%s\n' "$out"; } | head -n "$((rows - 1))" | while IFS= read -r line; do printf '%s\033[K\n' "$line"; done
    printf '\033[J'
    last=$out
  fi
  sleep 2
done
