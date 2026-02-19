FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV CACHE_BUST=11

# 1. System deps
RUN apt-get update && apt-get install -y \
    iverilog \
    curl \
    git \
    wget \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# 2. Node 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN node --version && npm --version

# 3. Download UVM 1.1d
RUN mkdir -p /uvm && \
    wget -q https://www.accellera.org/images/downloads/standards/uvm/uvm-1.1d.tar.gz \
         -O /tmp/uvm.tar.gz && \
    tar -xzf /tmp/uvm.tar.gz -C /tmp && \
    cp -r /tmp/uvm-1.1d/src /uvm/src && \
    rm -rf /tmp/uvm.tar.gz /tmp/uvm-1.1d

# 4. Patch UVM for iverilog compatibility
#    uvm_object_defines.svh uses 'type' parameter syntax iverilog doesn't support.
#    We replace the problematic `uvm_field_utils_begin macro with an iverilog-safe version.
RUN python3 - <<'EOF'
import re, sys

f = '/uvm/src/macros/uvm_object_defines.svh'
with open(f) as fh:
    src = fh.read()

# Print lines 170-185 for debugging
lines = src.split('\n')
for i, l in enumerate(lines[169:185], 170):
    print(f"{i}: {l}")

# Common iverilog incompatibility: `type' used as parameter type
# Replace `type T` with just removing the type keyword
src = re.sub(r'\btype\s+([A-Za-z_][A-Za-z0-9_]*)\b', r'\1', src)

with open(f, 'w') as fh:
    fh.write(src)

print("Patch applied OK")
EOF

# 5. App
WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3001
CMD ["node", "server.js"]
