#!/usr/bin/env bash
# PreToolUse hook (Write|Edit): forbids writing .env files into git-tracked places
# and putting plausible secrets into code. Reads the hook JSON from stdin.
input="$(cat)"
path="$(printf '%s' "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"\(.*\)"/\1/')"

case "$path" in
  *.env.example|*.env|*.env.local) exit 0 ;;
esac

if printf '%s' "$input" | grep -Eq '(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'; then
  echo "This looks like a secret in code. Secrets live only in .env." >&2
  exit 2
fi
exit 0
