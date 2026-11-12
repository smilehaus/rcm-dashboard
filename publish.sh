#!/bin/bash
# Run from the dashboard repo root to push updates to GitHub Pages.
cd "$(dirname "$0")"
git add -A
# Refuse a commit that would publish conflict markers or broken JSON.
if git diff --cached --name-only -- '*.json' | grep -q .; then
  node scripts/validate-json.mjs $(git diff --cached --name-only -- '*.json') || exit 1
fi
git commit -m "Dashboard update $(date '+%Y-%m-%d %H:%M')"
git push origin master
echo ""
echo "✓ Published → https://smilehaus.github.io/rcm-dashboard/"
