FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV CACHE_BUST=10

# 1. System deps
RUN apt-get update && apt-get install -y \
    iverilog \
    curl \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/*

# 2. Node 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN node --version && npm --version

# 3. Download UVM 1.1d — known to work with iverilog
RUN mkdir -p /uvm && \
    wget -q https://www.accellera.org/images/downloads/standards/uvm/uvm-1.1d.tar.gz -O /tmp/uvm.tar.gz && \
    tar -xzf /tmp/uvm.tar.gz -C /tmp && \
    cp -r /tmp/uvm-1.1d/src /uvm/src && \
    rm -rf /tmp/uvm.tar.gz /tmp/uvm-1.1d && \
    find /uvm -name "uvm_pkg.sv" && \
    find /uvm -name "uvm_macros.svh"

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3001
CMD ["node", "server.js"]
