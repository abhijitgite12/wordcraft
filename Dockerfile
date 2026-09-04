# Word Craft — container. Reproducible local AND deploy.
FROM node:22-alpine
WORKDIR /app

# Install deps (uses committed package-lock.json for reproducibility)
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Save (excludes heavy sources/build backups via .dockerignore)
COPY server.js ./
COPY public ./public
COPY data ./data
COPY words.json ./words.json

ENV PORT=4173
ENV ALLOW_RW=0
EXPOSE 4173
# APP_PASSWORD, OPENROUTER_API_KEY, SESSION_SECRET come from the environment
CMD ["node", "server.js"]