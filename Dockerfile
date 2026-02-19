FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV CACHE_BUST=16

# ── 1. System deps ────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    git autoconf flex bison help2man perl python3 \
    make libfl2 libfl-dev zlib1g zlib1g-dev \
    curl g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Build latest stable Verilator from source ──────────────────────────────
RUN git clone https://github.com/verilator/verilator.git /tmp/verilator \
    && cd /tmp/verilator \
    && git checkout stable \
    && autoconf \
    && ./configure \
    && make -j$(nproc) \
    && make install \
    && rm -rf /tmp/verilator

# ── 3. Install Node 20 ────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── 4. Verify + locate UVM ───────────────────────────────────────────────────
RUN verilator --version && node --version && npm --version
RUN find /usr/local/share/verilator -name "uvm_pkg.sv" 2>/dev/null || echo "uvm_pkg.sv not found"
RUN find /usr/local/share/verilator -name "uvm_macros.svh" 2>/dev/null || echo "uvm_macros.svh not found"

# ── 5. App ────────────────────────────────────────────────────────────────────
WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3001
CMD ["node", "server.js"]
