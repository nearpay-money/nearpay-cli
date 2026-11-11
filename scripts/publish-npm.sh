#!/usr/bin/env bash
# Publishes built @nearpay-money/* packages to the public npm registry, in the order given (dependencies first).
# Used by .github/workflows/release.yml; see nearpay/RELEASING.md.
#
#   scripts/publish-npm.sh [--dry-run] [--provenance] <package dir>...
#
# - Only @nearpay-money/* packages that are not private are accepted (never @nearpay/*, never @nearpay-internal/*).
# - Idempotent: a name@version already on npm is skipped.
# - Packs with `pnpm pack` (workspace:* ranges become exact versions) and publishes the tarball with npm from a
#   scratch directory, so the repository's .npmrc (which routes the NearPay scopes to a local registry) cannot
#   redirect the upload.
# - Auth: NODE_AUTH_TOKEN (an npm granular token with publish rights on @nearpay-money); not needed for --dry-run.
# - RELEASE_TAG (optional, e.g. v0.5.0): every package's version must equal it without the leading "v".
set -euo pipefail

npm_registry=https://registry.npmjs.org/
dry_run=0
provenance=--provenance=false
dirs=()
for a in "$@"; do
  case "$a" in
    --dry-run) dry_run=1 ;;
    --provenance) provenance=--provenance ;;
    -*) echo "publish-npm: unknown flag $a" >&2; exit 2 ;;
    *) dirs+=("$a") ;;
  esac
done
[ "${#dirs[@]}" -gt 0 ] || { echo "usage: publish-npm.sh [--dry-run] [--provenance] <package dir>..." >&2; exit 2; }

root="$(pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
userconfig="$work/.npmrc"
if [ "$dry_run" = 0 ]; then
  [ -n "${NODE_AUTH_TOKEN:-}" ] || { echo "publish-npm: NODE_AUTH_TOKEN is not set" >&2; exit 1; }
  # npm expands ${NODE_AUTH_TOKEN} itself; the token is never written to disk.
  # shellcheck disable=SC2016 # literal on purpose: npm expands it at run time
  printf '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n' >"$userconfig"
else
  : >"$userconfig"
fi
npm_() { (cd "$work" && npm "$@" --userconfig "$userconfig" --registry "$npm_registry" "--@nearpay-money:registry=$npm_registry"); }

# Check every package first, so a bad manifest fails before anything is published.
for d in "${dirs[@]}"; do
  read -r name version private < <(node -e 'const p=require(require("path").resolve(process.argv[1],"package.json"));console.log(p.name,p.version,p.private===true)' "$d")
  case "$name" in
    @nearpay-money/*) ;;
    *) echo "publish-npm: refusing $name ($d): only @nearpay-money/* packages are published" >&2; exit 1 ;;
  esac
  [ "$private" = false ] || { echo "publish-npm: refusing $name: private" >&2; exit 1; }
  if [ -n "${RELEASE_TAG:-}" ] && [ "v$version" != "$RELEASE_TAG" ]; then
    echo "publish-npm: $name is $version but the release tag is $RELEASE_TAG" >&2
    exit 1
  fi
  [ -d "$d/dist" ] || { echo "publish-npm: $d/dist missing (build first)" >&2; exit 1; }
done

for d in "${dirs[@]}"; do
  read -r name version < <(node -e 'const p=require(require("path").resolve(process.argv[1],"package.json"));console.log(p.name,p.version)' "$d")
  if out="$(npm_ view "$name@$version" version 2>&1)"; then
    if [ "$(printf '%s' "$out" | tail -1)" = "$version" ]; then
      echo "= $name@$version is already on npm, skipped"
      continue
    fi
  elif ! printf '%s' "$out" | grep -q E404; then
    printf '%s\n' "$out" >&2
    echo "publish-npm: could not check $name@$version on npm" >&2
    exit 1
  fi
  rm -f "$work"/*.tgz
  (cd "$root/$d" && pnpm pack --pack-destination "$work" >/dev/null)
  tgz="$(ls "$work"/*.tgz)"
  echo "+ $name@$version ($(basename "$tgz"), sha512 $(sha512sum "$tgz" | cut -c1-16)…)"
  if [ "$dry_run" = 1 ]; then
    npm_ publish "$tgz" --access public --provenance=false --dry-run
  else
    npm_ publish "$tgz" --access public "$provenance"
  fi
done
