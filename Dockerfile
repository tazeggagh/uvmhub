FROM verilator/verilator:5.020

ENV DEBIAN_FRONTEND=noninteractive
ENV CACHE_BUST=15

USER root

# 1. Install Node 20 + runtime deps
RUN apt-get update && apt-get install -y \
    curl \
    g++ \
    make \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# 2. Verify tools
RUN verilator --version && node --version && npm --version

# 3. Find UVM package
RUN find /usr -name "uvm_pkg.sv" 2>/dev/null || echo "UVM not in /usr" && \
    find /usr/local -name "uvm_pkg.sv" 2>/dev/null || echo "UVM not in /usr/local"

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3001
CMD ["node", "server.js"]
