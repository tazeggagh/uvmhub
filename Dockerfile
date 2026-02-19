FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV CACHE_BUST=12

# 1. System deps + Verilator
RUN apt-get update && apt-get install -y \
    verilator \
    g++ \
    make \
    git \
    curl \
    wget \
    perl \
    && rm -rf /var/lib/apt/lists/*

# Verify verilator version
RUN verilator --version

# 2. Node 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN node --version && npm --version

# 3. Install UVM for Verilator (uvm-systemc or generic UVM)
#    Verilator ships with a built-in UVM package since v4.020
RUN verilator --version | grep -oP '\d+\.\d+' | head -1

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3001
CMD ["node", "server.js"]
