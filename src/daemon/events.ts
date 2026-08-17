export type StewardEvent = { kind: string; [key: string]: unknown };

type Listener = (ev: StewardEvent) => void;

class EventBus {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(ev: StewardEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {}
    }
  }
}

export const bus = new EventBus();
