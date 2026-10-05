FROM node:22-alpine
WORKDIR /app
COPY server.mjs reports.mjs ./
ENV PORT=3100
EXPOSE 3100
CMD ["node", "server.mjs"]
