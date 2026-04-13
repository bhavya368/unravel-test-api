# Use the official Node.js runtime as the base image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy TypeScript config
COPY tsconfig.json ./

# Copy source files
COPY src ./src

# Build TypeScript to JavaScript
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --production

# Expose the port the app runs on
EXPOSE 8080

# Set the port environment variable (Cloud Run uses PORT env var)
ENV PORT=8080

# Start the application
CMD ["npm", "start"]

