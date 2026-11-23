#!/usr/bin/env bash
# Publish the site and make every visitor's browser pick up the new files.
# Usage: ./deploy.sh "what changed"
set -euo pipefail
cd "$(dirname "$0")"
v=$(date +%Y%m%d%H%M%S)
sed -i -E "s/var BUILD = \"[0-9]+\"/var BUILD = \"$v\"/; s/\?v=[0-9]+\"/?v=$v\"/g" index.html
printf '{"v":"%s"}\n' "$v" > version.json
git add -A
git -c user.name="AlienWithGlasses" -c user.email="AlienWithGlasses@users.noreply.github.com" commit -m "${1:-Update site} (build $v)"
git push origin main
echo "Deployed build $v. Open tabs reload themselves within 5 minutes or when focused."
