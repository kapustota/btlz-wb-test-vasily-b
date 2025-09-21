# Multi-stage build for Node.js application
FROM node:20-alpine AS deps-prod

WORKDIR /app

COPY ./package*.json .

RUN npm install --omit=dev

FROM deps-prod AS build

RUN npm install --include=dev

COPY . .

RUN npm run build

FROM node:20-alpine AS prod

WORKDIR /app

# Copy package files and install production dependencies
COPY --from=build /app/package*.json .
COPY --from=deps-prod /app/node_modules ./node_modules

# Copy built application
COPY --from=build /app/dist ./dist

# Copy environment files
COPY --from=build /app/.env ./

# Copy Google Sheets configuration files
COPY --from=build /app/spreadsheets.json ./
COPY --from=build /app/spreadsheetsServiceAccountKey.json ./

# Set timezone
ENV TZ=Europe/Moscow
RUN apk add --no-cache tzdata

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Change ownership of the app directory
RUN chown -R nodejs:nodejs /app
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "console.log('Health check passed')" || exit 1

# Start the application
CMD ["node", "dist/app.js"]