FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs admin.mjs LICENSE ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node MindSpark/public ./MindSpark/public
COPY --chown=node:node MindSpark/LICENSE ./MindSpark/LICENSE
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/home.db
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get({host:'127.0.0.1',port:3000,path:'/healthz',headers:{Host:new URL(process.env.APP_ORIGIN||'http://localhost:3000').host}},r=>{r.resume();if(r.statusCode!==200)process.exit(1)}).on('error',()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
