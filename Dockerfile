FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV CACHE_BUST=5

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

# 3. Verify Node
RUN node --version && npm --version

# 4. Clone UVM 1.2 into /uvm and verify key files exist
RUN git clone --depth=1 https://github.com/chiggs/uvm.git /uvm \
    && ls /uvm/src/uvm_pkg.sv \
    && ls /uvm/src/macros/uvm_macros.svh

# 5. App
WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3001
CMD ["node", "server.js"]
