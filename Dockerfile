FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV CACHE_BUST=9

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

# 3. Clone chiggs/uvm — patched specifically for iverilog compatibility
RUN git clone --depth=1 https://github.com/chiggs/uvm.git /uvm \
    && find /uvm -name "uvm_pkg.sv" \
    && find /uvm -name "uvm_macros.svh"

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3001
CMD ["node", "server.js"]
