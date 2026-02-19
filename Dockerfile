FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV CACHE_BUST=15

# 1. Install Verilator build deps + runtime deps
RUN apt-get update && apt-get install -y \
    git autoconf flex bison help2man perl python3 \
    make libfl2 libfl-dev zlib1g zlib1g-dev \
    curl g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2. Build Verilator 5.020 from source
RUN git clone https://github.com/verilator/verilator.git /tmp/verilator \
    && cd /tmp/verilator \
    && git checkout v5.020 \
    && autoconf \
    && ./configure \
    && make -j$(nproc) \
    && make install \
    && rm -rf /tmp/verilator

# 3. Install Node 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# 4. Verify tools
RUN verilator --version && node --version && npm --version

# 5. Find UVM package (informational)
RUN find /usr -name "uvm_pkg.sv" 2>/dev/null || echo "UVM not in /usr" && \
    find /usr/local -name "uvm_pkg.sv" 2>/dev/null || echo "UVM not in /usr/local"

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .
EXPOSE 3001
CMD ["node", "server.js"]
