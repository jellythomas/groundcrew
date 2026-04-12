#!/usr/bin/env bash
set -euo pipefail

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Cloning groundcrew..."
git clone --depth 1 https://github.com/jellythomas/groundcrew.git "$TMP_DIR" 2>/dev/null

echo "Building CLI..."
cd "$TMP_DIR/groundcrew/cli"
npm install --ignore-scripts
npm run build

echo "Installing globally..."
npm install -g .

echo "Done! Run 'groundcrew --help' to get started."
