FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data/excels /app/data/pptx-tmp

ENV PORT=4004
ENV EXCEL_STORE_PATH=/app/data/excels

EXPOSE 4004

CMD ["node", "server.js"]
