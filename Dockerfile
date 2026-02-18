FROM ubuntu:22.04

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
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Clone UVM base library (open-source UVM 1.2)
RUN git clone https://github.com/chiggs/uvm.git /uvm

WORKDIR /app

COPY package.json .
RUN npm install

COPY server.js .

EXPOSE 3001

CMD ["node", "server.js"]
