# 1. Use a Linux base image that has Node.js
FROM node:18-slim

# 2. Install the C compiler tools (Flex, Bison, GCC)
RUN apt-get update && apt-get install -y \
    flex \
    bison \
    gcc \
    make \
    && rm -rf /var/lib/apt/lists/*

# 3. Create the app folder
WORKDIR /usr/src/app

# 4. Copy package files and install Node dependencies
COPY package.json ./
RUN npm install

# 5. Copy the rest of your source code
COPY . .

# 6. COMPILE YOUR LANGUAGE (The Linux version)
# We generate the C files and compile them to a file named 'edoc'
RUN flex lexer.l
RUN bison -d parser.y
RUN gcc lex.yy.c parser.tab.c -o edoc

# 7. Start the server
EXPOSE 3000
CMD [ "node", "server.js" ]