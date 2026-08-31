FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

RUN corepack enable && corepack prepare pnpm@11.1.3 --activate

COPY --chown=root:root run-step.mjs snapshot.mjs /opt/ww/
RUN chmod 0555 /opt/ww/run-step.mjs /opt/ww/snapshot.mjs

WORKDIR /workspace
USER node
