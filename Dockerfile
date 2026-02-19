FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV CACHE_BUST=14

# 1. System deps
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    make \
    autoconf \
    automake \
    flex \
    bison \
    g++ \
    libfl2 \
    libfl-dev \
    zlib1g \
    zlib1g-dev \
    perl \
    python3 \
    ccache \
    && rm -rf /var/lib/apt/lists/*

# 2. Node 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN node --version && npm --version

# 3. Build Verilator 5.x from source
#    v5.020 is stable and has full --uvm support
RUN git clone --depth=1 --branch v5.020 \
        https://github.com/verilator/verilator.git /verilator-src \
    && cd /verilator-src \
    && autoconf \
    && ./configure \
    && make -j$(nproc) \
    && make install \
    && cd / && rm -rf /verilator-src

# Verify version
RUN verilator --version

# 4. Find UVM package that ships with Verilator 5
RUN find /usr/local/share/verilator -name "uvm_pkg.sv" 2>/dev/null || \
    find /usr/share/verilator -name "uvm_pkg.sv" 2>/dev/null || \
    echo "UVM not found in default paths"

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3001
CMD ["node", "server.js"]
