# # Use official Node 20 Alpine image
# FROM node:20-alpine

# # Set working directory
# WORKDIR /app

# # Copy package files first for optimal caching
# COPY package.json package-lock.json ./

# # Install all dependencies
# RUN npm ci

# # Copy source code and configuration files
# COPY src/ ./src/
# COPY tsconfig.json ./

# # Build the TypeScript application
# RUN npm run build

# # Remove devDependencies to reduce image size
# RUN npm prune --production

# # Set non-root user for security
# RUN chown -R node:node /app
# USER node

# # Expose application port
# EXPOSE 3000

# ENV NODE_ENV=production

# # Start command
# CMD ["npm", "start"]

# Use official Node 20 Alpine image
FROM node:20-alpine

# Enable Yarn 4+ corepack
RUN corepack enable

# Set working directory
WORKDIR /app

# Copy package files first for optimal caching
COPY package.json yarn.lock .yarnrc.yml ./

# Install production dependencies (Yarn 4+)
COPY .yarn ./.yarn
RUN yarn install

# Copy application files
COPY . .

# Set non-root user for security
RUN chown -R node:node /app
USER node

# Expose application port
EXPOSE 3000
ENV NODE_ENV="dev"

# Start command
CMD ["yarn", "start"]
