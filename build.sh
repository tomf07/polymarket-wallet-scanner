#!/bin/sh
# Builds the deployable site into dist/ — minified + name-mangled JS/CSS.
# Deploy ONLY dist/.
# Works on macOS (local) and Linux (Vercel build machines) — fetches the
# matching standalone esbuild binary, no Node/npm required.
set -e
cd "$(dirname "$0")"

ESBUILD_VERSION=0.28.1
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  PKG=darwin-arm64 ;;
  Darwin-x86_64) PKG=darwin-x64 ;;
  Linux-x86_64)  PKG=linux-x64 ;;
  Linux-aarch64|Linux-arm64) PKG=linux-arm64 ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

ESBUILD=".build-cache/esbuild-$PKG-$ESBUILD_VERSION"
if [ ! -x "$ESBUILD" ]; then
  echo "Fetching esbuild $ESBUILD_VERSION for $PKG (one-time)…"
  mkdir -p .build-cache
  curl -sL "https://registry.npmjs.org/@esbuild/$PKG/-/$PKG-$ESBUILD_VERSION.tgz" \
    | tar -xz -C .build-cache --strip-components=2 package/bin/esbuild
  mv .build-cache/esbuild "$ESBUILD"
  chmod +x "$ESBUILD"
fi

rm -rf dist
mkdir dist
# core.js (shared with the CLI) + app.js ship as one file. core.js is minified
# without a --format so esbuild leaves its module/global export check alone
# (any format makes it wrap the file as CommonJS and the global never appears)
"$ESBUILD" core.js --minify --outfile=.build-cache/core.min.js --log-level=warning
"$ESBUILD" app.js --bundle --minify --format=iife --outfile=.build-cache/app.min.js --log-level=warning
cat .build-cache/core.min.js .build-cache/app.min.js > dist/app.js
"$ESBUILD" styles.css --minify --outfile=dist/styles.css --log-level=warning
grep -v '<script src="core.js"></script>' index.html > dist/index.html

# content-hashed filenames: every deploy gets fresh asset URLs, so browsers
# can never pair a new index.html with a stale cached app.js
JS_HASH=$(openssl dgst -sha256 dist/app.js | awk '{print substr($NF,1,8)}')
CSS_HASH=$(openssl dgst -sha256 dist/styles.css | awk '{print substr($NF,1,8)}')
mv dist/app.js "dist/app.$JS_HASH.js"
mv dist/styles.css "dist/styles.$CSS_HASH.css"
sed -i.bak "s|src=\"app\.js\"|src=\"app.$JS_HASH.js\"|; s|href=\"styles\.css\"|href=\"styles.$CSS_HASH.css\"|" dist/index.html
rm -f dist/index.html.bak

echo "dist/ ready:"
ls dist
wc -c app.js "dist/app.$JS_HASH.js" | sed 's/^ *//'
