FROM ubuntu:22.04
# Node 20 will be installed via NodeSource below

ENV DEBIAN_FRONTEND=noninteractive

# Install Icarus Verilog + dependencies
RUN apt-get update && apt-get install -y \
    iverilog \
    curl \
    git \
    make \
    gcc \
    g++ \
    perl \
    && rm -rf /var/lib/apt/lists/*

# Install Node 20 via NodeSource (avoids old Ubuntu default Node)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Clone UVM base library (open-source UVM 1.2)
RUN git clone https://github.com/chiggs/uvm.git /uvm

WORKDIR /app

COPY package.json .
RUN npm install

COPY server.js .

EXPOSE 3001

CMD ["node", "server.js"]
