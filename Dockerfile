FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV CACHE_BUST=7

# 1. System deps
RUN apt-get update && apt-get install -y \
    iverilog \
    curl \
    git \
    make \
    gcc \
    g++ \
    perl \
    && rm -rf /var/lib/apt/lists/*

# 2. Node 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN node --version && npm --version

# 5. Debug — show exact UVM file locations
RUN find /uvm -name "uvm_macros.svh" && find /uvm -name "uvm_pkg.sv"

# 3. Copy UVM from repo (uvm/ folder must exist in your repo)
COPY uvm/ /uvm/

# 4. App
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3001
CMD ["node", "server.js"]
