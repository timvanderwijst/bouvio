// Browser-preview stand-ins for this area's runner methods (`handlers`) and
// desktop-only app methods (`app`). See ../mock-bus.ts to fire live events.
export const handlers: Record<string, (p: Record<string, any>) => unknown> = {};
export const app: Record<string, (p: Record<string, any>) => unknown> = {};
