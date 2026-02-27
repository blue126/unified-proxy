FROM node:20-slim
WORKDIR /app
COPY package.json server.js ./
EXPOSE 3456
CMD ["node", "server.js"]
