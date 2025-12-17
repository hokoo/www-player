#!/bin/bash
set -euo pipefail

# Change to repository directory
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node.js v18 or newer: https://nodejs.org/"
  read -rp "Press Enter to exit..." _
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js v18 or newer: https://nodejs.org/"
  read -rp "Press Enter to exit..." _
  exit 1
fi

echo "Starting CHGK player..."
open "http://localhost:3000/"

# Start server
npm start
