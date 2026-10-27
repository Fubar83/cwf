#!/bin/sh
# wag tmux example: show the next repo's git pane and terminal on the right of the feature's main window.
# The agent pane on the left never moves. Bound to "prefix g" by the tmux profile in examples/tmux-switch.yaml.
# Copy this file to ~/.config/wag/tmux-next-repo.sh. Usage: tmux-next-repo.sh <tmux session name>

s="$1"
main=$(tmux show-options -t "=$s:" -v @wag_main 2>/dev/null)
[ -n "$main" ] || exit 0
panes=$(tmux list-panes -s -t "=$s" -F '#{window_id} #{pane_id} #{@wag_role} #{@wag_wt}')

# The repo shown in the main window now.
cur_git=; cur_term=; cur_wt=
while read -r win id role wt; do
  [ "$win" = "$main" ] && [ "$role" = git ] && cur_git=$id && cur_wt=$wt
  [ "$win" = "$main" ] && [ "$role" = term ] && cur_term=$id
done <<EOF
$panes
EOF
[ -n "$cur_git" ] || exit 0

# The repos in name order, and the one after the current one, wrapping around.
next=$(printf '%s\n' "$panes" | while read -r win id role wt; do [ "$role" = git ] && printf '%s\n' "$wt"; done |
  sort | awk -v cur="$cur_wt" '{ a[NR] = $0; if ($0 == cur) i = NR } END { if (NR > 1 && i) print a[i % NR + 1] }')
[ -n "$next" ] || exit 0

next_git=; next_term=
while read -r win id role wt; do
  [ "$wt" = "$next" ] && [ "$role" = git ] && next_git=$id
  [ "$wt" = "$next" ] && [ "$role" = term ] && next_term=$id
done <<EOF
$panes
EOF
[ -n "$next_git" ] && [ -n "$next_term" ] || exit 0

# Swap both panes; their programs keep running. Then name each window after the repo it shows.
tmux swap-pane -d -s "$next_git" -t "$cur_git"
tmux swap-pane -d -s "$next_term" -t "$cur_term"
tmux rename-window -t "$main" "$(tmux display -p -t "$next_git" '#{@wag_repo}')"
tmux rename-window -t "$(tmux display -p -t "$cur_git" '#{window_id}')" "$(tmux display -p -t "$cur_git" '#{@wag_repo}')"
