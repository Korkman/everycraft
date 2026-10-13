FROM docker.io/library/node:22-alpine

RUN apk add --no-cache unzip \
 && mkdir -p /data && chown node:node /data

WORKDIR /app
COPY server ./server
COPY web ./web

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
USER node

CMD ["node", "server/index.js"]
