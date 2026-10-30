# A wag feature create hook: when the branch's last segment looks like a Jira key
# (feature/vfs-1234, bugfix/VFS-1234, VFS-1234), write NOTES.md in the feature folder with a link to
# the ticket and the repos the feature spans. Any other branch name is left alone.
#
#   hooks:
#     feature:
#       create:
#         - jira-notes.sh https://yourcompany.atlassian.net
#
# Keep it next to your config file (~/.config/wag/jira-notes.sh) and wag runs it with bash from the
# feature folder, so it needs no execute bit and no shebang. Runs once, when the feature is created.
#
#   $1  your Jira base URL (default: the placeholder below)
#   $2  the file to write (default: NOTES.md)

base=${1:-https://yourcompany.atlassian.net}
notes=${2:-NOTES.md}

# The last segment of the branch, so feature/vfs-1234 is vfs-1234. Two or more letters, a dash, digits.
key=${WAG_BRANCH##*/}
if [[ ! $key =~ ^[A-Za-z][A-Za-z0-9]+-[0-9]+$ ]]; then
  echo "jira-notes: no ticket key at the end of $WAG_BRANCH, so no $notes" >&2
  exit 0
fi
key=$(printf '%s' "$key" | tr '[:lower:]' '[:upper:]')

# Never overwrite notes that are already there: this feature has been opened before.
if [ -e "$notes" ]; then
  echo "jira-notes: $notes already exists, left as it is" >&2
  exit 0
fi

{
  printf '# %s\n\n' "$key"
  printf '%s/browse/%s\n\n' "${base%/}" "$key"
  printf -- '- Branch: `%s`\n' "$WAG_BRANCH"
  printf -- '- Repos: %s\n' "$(printf '%s' "$WAG_REPOS" | tr '\n' ' ')"
  printf '\n## Notes\n\n'
} > "$notes"
echo "jira-notes: wrote $notes for $key" >&2
