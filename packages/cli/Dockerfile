FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
COPY packages/shared/package.json ./packages/shared/

# Install pnpm
RUN npm install -g pnpm

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages ./packages
COPY tsconfig.base.json ./

# Build the CLI
RUN pnpm --filter cloudeval-cli build:standalone

# Final stage - minimal runtime
FROM node:20-alpine

WORKDIR /app

# Copy only production dependencies and built files
COPY --from=builder /app/packages/cli/dist ./dist
COPY --from=builder /app/packages/cli/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Make it executable
RUN chmod +x dist/cli.js

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["chat", "--help"]




