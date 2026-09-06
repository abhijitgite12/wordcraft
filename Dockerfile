# Word Craft — container. Reproducible local AND deploy.
FROM node:22-alpine
WORKDIR /app

# Install deps (uses committed package-lock.json for reproducibility)
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Python + Edge-TTS for human neural voices (free, no key)
RUN apk add --no-cache python3 py3-pip && \
    pip3 install --no-cache-dir --break-system-packages edge-tts

# Save (excludes heavy sources/build backups via .dockerignore)
COPY server.js ./
COPY public ./public
COPY data ./data
COPY words.json ./words.json

ENV PORT=4173
ENV ALLOW_RW=0
# Bake the build (release) moment + git context into the image.
ARG BUILD_TIME
ARG BUILD_COMMIT
ARG BUILD_BRANCH
ENV BUILD_TIME=$BUILD_TIME
ENV BUILD_COMMIT=$BUILD_COMMIT
ENV BUILD_BRANCH=$BUILD_BRANCH
EXPOSE 4173
# APP_PASSWORD, OPENROUTER_API_KEY, SESSION_SECRET come from the environment
CMD ["node", "server.js"]