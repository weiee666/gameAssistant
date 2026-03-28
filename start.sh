#!/bin/bash
# Start the OpenClaw Chat server
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting OpenClaw Chat on port ${PORT:-7788}..."
node server.js
