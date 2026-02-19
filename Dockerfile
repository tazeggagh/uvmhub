FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV CACHE_BUST=6

# 1. System deps
RUN apt-get update && apt-get install -y \
    iverilog \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# 2. Node 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN node --version && npm --version

WORKDIR /app

# 3. Copy UVM files from repo (no git clone at build time)
COPY uvm/ /uvm/

# Verify key files exist — build fails here if structure is wrong
RUN ls /uvm/src/uvm_pkg.sv \
    && ls /uvm/src/macros/uvm_macros.svh \
    && ls /uvm/src/macros/uvm_tlm_defines.svh \
    && echo "UVM files OK"

# 4. App
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3001
CMD ["node", "server.js"]
