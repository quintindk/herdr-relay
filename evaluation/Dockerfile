FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
RUN apt-get update && apt-get install -y --no-install-recommends tmux git python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openrig/cli@0.6.4 paperclipai@2026.1001.0
USER node
WORKDIR /home/node
ENV DO_NOT_TRACK=1 PAPERCLIP_TELEMETRY_DISABLED=1
CMD ["sleep", "infinity"]
