FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# 1. Install system deps + curl first
RUN apt-get update && apt-get install -y \
    iverilog \
    curl \
    git \
    make \
    gcc \
    g++ \
    perl \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Node 20 via NodeSource (BEFORE npm install)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# 3. Verify versions (helpful for debugging)
RUN node --version && npm --version

# 4. Clone UVM library
RUN git clone https://github.com/chiggs/uvm.git /uvm

WORKDIR /app

# 5. Install npm packages using Node 20
COPY package.json .
RUN npm install

COPY server.js .

EXPOSE 3001

CMD ["node", "server.js"]
