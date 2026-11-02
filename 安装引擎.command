#!/bin/zsh
set -e
cd "${0:A:h}"
if ! command -v uv >/dev/null; then
  print '开发源码运行需要 uv。已打包的 Mac 应用自带运行环境，不需要执行此脚本。'
  exit 1
fi
if [[ ! -f .runtime/astrbot-source/main.py ]]; then
  git clone --depth 1 --branch v4.29.3 https://github.com/AstrBotDevs/AstrBot.git .runtime/astrbot-source
fi
cp runtime/astrbot-4.29.3.uv.lock .runtime/astrbot-source/uv.lock
node scripts/patch-managed-runtime.mjs
cd .runtime/astrbot-source
uv sync --locked --no-dev --no-install-project --python 3.12
# LivingMemory adds these two runtime dependencies beyond the AstrBot lockfile.
# Keep these pins aligned with deploy/Dockerfile.
uv pip install --python .venv/bin/python --no-deps networkx==3.7 pytz==2026.6
print '本机 AstrBot 开发环境已准备好。'
