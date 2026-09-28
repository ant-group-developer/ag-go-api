FROM node:22-bookworm-slim AS base

WORKDIR /app
ENV COREPACK_HOME=/tmp/corepack

RUN corepack enable && corepack prepare yarn@1.22.22 --activate

FROM base AS dependencies

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM dependencies AS build

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN yarn build

FROM base AS production-dependencies

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true && yarn cache clean

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# The slim image ships no fonts, so sharp/librsvg draws watermark text as missing-glyph boxes.
# Liberation is metric-compatible with Arial/Times New Roman/Courier New (fontconfig aliases them);
# DejaVu is the fallback for unknown families. Roboto, Open Sans and Noto Sans/Serif back the other
# choices of the watermark font picker (ag-go-web/src/modules/render/utils/watermark-fonts.ts).
# Extra .ttf/.otf files dropped into ./fonts are installed as well.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fontconfig fonts-liberation fonts-dejavu-core \
    fonts-roboto-unhinted fonts-open-sans fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*
COPY fonts/ /usr/share/fonts/truetype/ag-go/
RUN fc-cache -f

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000

CMD ["node", "dist/main.js"]
