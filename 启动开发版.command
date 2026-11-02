#!/bin/zsh
set -e
cd "${0:A:h}"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
npm run desktop
