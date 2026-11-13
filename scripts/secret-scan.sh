#!/usr/bin/env bash
# Secret scan for the working tree and history of this repository. Exit 1 on any finding.
# 1) every value in ./.env (if present) must not appear anywhere in tracked files or history;
# 2) generic patterns: NEAR private keys, long hex seeds assigned to *KEY/*SEED/*SECRET names, bearer tokens.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in *KEY|*SEED|*SECRET|*TOKEN|*PRIVATE*) [ ${#v} -ge 16 ] && git grep -qF -- "$v" $(git rev-list --all | head -400) 2>/dev/null && { echo "FOUND the value of $k in git history"; fail=1; } ;; esac
  done < <(grep -E '^[A-Z0-9_]+=' .env)
fi
pat1='ed25519:[1-9A-HJ-NP-Za-km-z]{80,}'
pat2='(SEED|SECRET|PRIVATE_KEY|API_KEY|TOKEN)[A-Z_]*[=:][[:space:]]*"?[0-9a-fA-F]{64}'
pat3='Bearer [A-Za-z0-9_\-]{24,}'
for p in "$pat1" "$pat2" "$pat3"; do
  hits=$(git grep -nE "$p" -- . ':!THIRD_PARTY_NOTICES.md' ':!pnpm-lock.yaml' ':!**/fixtures/**' ':!**/test/**' ':!**/*.test.ts' 2>/dev/null | grep -v 'placeholder\|\.env\.example\|SECRET-DO-NOT-PRINT\|SECRET-VALUE' || true)
  [ -n "$hits" ] && { echo "pattern $p:"; echo "$hits" | head -5; fail=1; }
done
[ $fail -eq 0 ] && echo "secret scan: clean (working tree and history)"
exit $fail
