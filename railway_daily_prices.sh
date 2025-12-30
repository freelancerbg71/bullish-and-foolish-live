#!/usr/bin/env bash
set -euo pipefail

: "${RAILWAY_VOLUME_MOUNT_PATH:=/data}"

export EDGAR_USER_AGENT="${EDGAR_USER_AGENT:-BullishAndFoolish/1.2 (contact via GitHub)}"
export DATA_DIR="${DATA_DIR:-$RAILWAY_VOLUME_MOUNT_PATH}"
export FUNDAMENTALS_DB_FILE="${FUNDAMENTALS_DB_FILE:-${RAILWAY_VOLUME_MOUNT_PATH}/edgar/fundamentals.db}"
export NASDAQ_LAST_TRADE_URL="${NASDAQ_LAST_TRADE_URL:-https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=0&download=true}"
export DATA_USER_AGENT="${DATA_USER_AGENT:-$EDGAR_USER_AGENT}"

node worker/jobs/daily-last-trade.js
