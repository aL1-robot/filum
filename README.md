# Needle Planner

A responsive React and TypeScript planner for FluidNC string-art machines. Create nail sequences, preview toolpaths, calibrate the machine, and generate, upload, or run G-code. Planner and FluidNC logic live in DOM-free TypeScript modules; React and canvas handle the interface.

## Development

From this directory:

```sh
pnpm install
pnpm run dev
```

Use `pnpm run build` to create a production build and `pnpm run lint` to lint the project.

## Interface

The desktop sidebar provides FluidNC connection, calibration, and motion controls. The top bar has **File**, **Settings**, and **Machine** popup menus; select an item to open its dialog. On mobile, use the hamburger menu.
