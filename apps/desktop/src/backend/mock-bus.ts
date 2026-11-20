import type { EventName } from "./types";

// The preview's event bus, so area mocks can fire live events too.
type Cb = (p: unknown) => void;
export const listeners = new Map<EventName | string, Set<Cb>>();
export const mockFire = (e: EventName | string, p: unknown) => listeners.get(e)?.forEach((f) => f(p));
