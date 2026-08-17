FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

# Copy source
COPY src/ ./src/

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000', r => process.exit(r.statusCode===200?0:1))" || exit 1

EXPOSE 3000
CMD ["npm", "start"]
