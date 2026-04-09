#!/bin/bash
# Run from apps/rcm-dashboard/ to push updates to GitHub Pages
cd "$(dirname "$0")"
git add -A
git commit -m "Dashboard update $(date '+%Y-%m-%d %H:%M')"
git push origin master
echo ""
echo "✓ Published → https://smilehaus.github.io/rcm-dashboard/"
