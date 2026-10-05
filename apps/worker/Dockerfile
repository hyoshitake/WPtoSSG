FROM node:22-bookworm-slim

ENV NODE_ENV=development
WORKDIR /workspace

COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/config/package.json packages/config/package.json

RUN npm ci

COPY . .

EXPOSE 4001

CMD ["npm", "run", "dev:worker"]
