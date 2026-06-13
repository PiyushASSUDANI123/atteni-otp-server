FROM node:18-slim

# Install Chromium and necessary dependencies for Puppeteer/whatsapp-web.js
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer environment variables so it uses the installed chromium and skips downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Hugging Face Spaces requires running as a non-root user (UID 1000)
RUN useradd -m -u 1000 user
USER user

# Set home directory and PATH
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

# Set working directory
WORKDIR $HOME/app

# Copy package files with correct ownership
COPY --chown=user package*.json ./

# Install dependencies
RUN npm install

# Copy application code with correct ownership
COPY --chown=user . $HOME/app

# Hugging Face Spaces runs on port 7860 by default
EXPOSE 7860
ENV PORT=7860

# Start the application
CMD ["node", "index.js"]
