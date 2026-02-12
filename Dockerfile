FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY vendor/ ./vendor/
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
