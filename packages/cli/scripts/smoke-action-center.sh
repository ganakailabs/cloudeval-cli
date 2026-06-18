#!/usr/bin/env bash
set -euo pipefail

cloudeval auth status
cloudeval actions list --limit 5 --format json
cloudeval actions list --type architecture --severity critical --format json
cloudeval actions open --print-url --no-open
