# Stage 1: Dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY ./new-release/shade-agent-js ./new-release/shade-agent-js
COPY package.json package-lock.json ./
RUN npm ci --only=production

# Stage 2: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY ./new-release/shade-agent-js ./new-release/shade-agent-js
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --include=dev
COPY src/ ./src/
RUN npm run build
RUN ls -l node_modules/@neardefi/shade-agent-js || (echo 'shade-agent-js not found!' && exit 1)

# Stage 3: Production
FROM node:22-alpine AS runner
WORKDIR /app
# COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/new-release/shade-agent-js ./new-release/shade-agent-js
COPY package.json ./
CMD ["npm", "start"]
