FROM node:21-alpine
WORKDIR /app
COPY package*.json ./
COPY . .
RUN npm install
RUN npm uninstall --save sqlite3 
RUN npm install --save sqlite3
EXPOSE 4000
CMD ["node", "index.js"]

