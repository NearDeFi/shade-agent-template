# Use official Node 20 Alpine image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files first for optimal caching
COPY package.json package-lock.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/ 

# Set non-root user for security
RUN chown -R node:node /app
USER node

# Expose application port
EXPOSE 3000

ENV NODE_ENV=production

# Start command
CMD ["npm", "start"]