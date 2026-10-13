#!/usr/bin/env python3
"""Create private LiteLLM settings with separate admin and client keys."""

from __future__ import annotations

import argparse
import os
import secrets
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=root / ".env.litellm")
    args = parser.parse_args()

    db_password = secrets.token_hex(24)
    content = (
        f"LITELLM_MASTER_KEY=sk-{secrets.token_hex(32)}\n"
        f"LITELLM_SALT_KEY=sk-{secrets.token_hex(32)}\n"
        f"LITELLM_DB_PASSWORD={db_password}\n"
        f"LITELLM_DATABASE_URL=postgresql://litellm:{db_password}@postgres:5432/litellm\n"
        f"PROXY_API_KEY=sk-{secrets.token_hex(32)}\n"
        f"CLAUDE_CODE_PROXY_KEY=sk-{secrets.token_hex(32)}\n"
        "LITELLM_RPM_LIMIT=120\n"
        "LITELLM_TPM_LIMIT=1000000\n"
        "LITELLM_HOST_PORT=4000\n"
        "CHATGPT_TOKEN_DIR=./.litellm/chatgpt\n"
        "LITELLM_DEPLOY_WORKFLOW_READY=0\n"
        "ANTHROPIC_API_KEY=\n"
    )
    auth_root = root / ".litellm"
    auth_root.mkdir(mode=0o700, exist_ok=True)
    (auth_root / "chatgpt").mkdir(mode=0o700, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            file.write(content)
    except FileExistsError:
        print(f"Settings file already exists: {args.output}", file=sys.stderr)
        return 1
    print(f"Created private settings at {args.output}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
