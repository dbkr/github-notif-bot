FROM node:16-slim as builder

WORKDIR /build

COPY package.json tsconfig.json yarn.lock /build/
COPY src/ /build/src/

RUN yarn install && yarn run build

FROM node:16-slim

WORKDIR /app

COPY package.json yarn.lock /app/
COPY --from=builder /build/lib/ /app/lib/

RUN yarn install --production

VOLUME /cfg
WORKDIR /cfg

CMD ["node", "/app/lib/main.js"]
