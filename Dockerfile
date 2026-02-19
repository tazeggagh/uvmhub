FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV CACHE_BUST=19

# ── 1. System deps ────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    git autoconf flex bison help2man perl python3 \
    make libfl2 libfl-dev zlib1g zlib1g-dev \
    curl g++ ca-certificates \
    z3 \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Build recent Verilator (UVM-capable) ───────────────────────────────────
RUN git clone https://github.com/verilator/verilator.git /tmp/verilator \
    && cd /tmp/verilator \
    && git checkout master \
    && autoconf \
    && ./configure \
    && make -j$(nproc) \
    && make install \
    && rm -rf /tmp/verilator

# ── 3. Install Node 20 ────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── 4. Verify tools ───────────────────────────────────────────────────────────
RUN verilator --version && node --version && npm --version && z3 --version

# ── 5. App ────────────────────────────────────────────────────────────────────
WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

# ── 6. Copy UVM from repo into /opt/uvm ──────────────────────────────────────
RUN mkdir -p /opt/uvm
COPY uvm/ /opt/uvm/
RUN echo "=== UVM contents ===" && find /opt/uvm -type f | head -20

EXPOSE 3001
CMD ["node", "server.js"]
