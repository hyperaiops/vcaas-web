# Workspace agent instructions

This is a Next.js workspace scaffolded by the Web IDE, not the IDE host itself.

## Project

- Next.js 15.5.9, React 19, TypeScript, and the **Pages Router**. The starting page is `pages/index.tsx`; shared pages configuration is in `pages/_app.tsx` and `pages/_document.tsx`.
- `next.config.ts` currently uses `output: "export"` and webpack. Preserve the Pages Router and existing configuration unless the user's requirements require a deliberate change.
- The IDE mounts a snapshot of the source workspace into a browser WebContainer and manages dependency installation and `pnpm dev` there. Its preview filesystem is separate from the agent's source workspace; refresh the preview when needed.

## Mandatory workspace rules

- **Do not run builds in the workspace.** Do not run `next build`, `pnpm build`, `npm run build`, static export, or other commands that generate build output. Do not start a separate development server in the source workspace; the IDE manages the preview.
- **Do not install dependencies or create `node_modules` in the source workspace.** If dependencies are needed, declare them in `package.json` and let the IDE manage installation in its preview environment. Do not remove the existing build scripts merely because agents must not run them.
- Do not create or commit generated directories or files such as `node_modules`, `.next`, `out`, `dist`, `build`, or `*.tsbuildinfo` in the source workspace. If any already exist there, tell the user and ask them to remove them or explicitly approve cleanup; do not delete them automatically.
- These rules do not require deleting the preview-managed `node_modules` or `.next` inside the separate WebContainer; those are needed by the IDE's development runtime.
- Use non-generating checks only when they are already available without installing dependencies. If a check would require a build or a workspace installation, skip it and explain what was not verified.

## SQLite and ORM

- SQLite with an ORM is allowed when the requested functionality needs it. Choose dependencies and a SQLite driver that work in the target runtime; native Node addons or ORM engines are not guaranteed to work in WebContainer. Do not add database dependencies without a reason.
- Keep server-side database access and credentials out of client bundles. The current static export cannot provide runtime API routes or server-side database access: if the feature needs a Node server, discuss the necessary configuration and deployment change with the user rather than pretending static export supports it.
- Do not assume a host-specific database path or persistent mount. Data written inside the browser preview may be ephemeral and is not automatically synchronized back to the source workspace. Agree on durable storage and migrations when persistence is required, and never delete an existing database or its data without permission.
- Do not place real secrets in workspace files. In particular, the IDE includes `.env.local` in workspace snapshots, so it is not a safe place for secret credentials.
