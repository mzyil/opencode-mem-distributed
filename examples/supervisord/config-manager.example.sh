#!/bin/sh
# examples/supervisord/config-manager.example.sh
# Writes the opencode-mem config from env, then drops a readiness flag.
set -eu

mkdir -p /root/.config/opencode
cat > /root/.config/opencode/opencode-mem.jsonc <<EOF
{
  "storage": {
    "recordStore": { "kind": "postgres", "url": "env://DATABASE_URL", "poolSize": ${OPENCODE_MEM_POOL_SIZE:-4} },
    "vectorBackend": { "kind": "${OPENCODE_MEM_VECTOR_BACKEND:-pgvector}" }
  }
}
EOF

touch /var/run/opencode-mem.ready
echo "config-manager: ready"
