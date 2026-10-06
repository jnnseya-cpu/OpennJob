import type { DomainEvent } from './types';

export type EventHandler = (event: DomainEvent) => void | Promise<void>;

/**
 * Domain events go through this interface so that Kafka (or any broker) can replace the
 * in-process implementation later without touching the publishers.
 */
export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  /** Subscribe to one event type, or '*' for all. Returns an unsubscribe function. */
  subscribe(type: string, handler: EventHandler): () => void;
}

export class InProcessEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  async publish(event: DomainEvent): Promise<void> {
    const targets = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get('*') ?? [])];
    for (const handler of targets) await handler(event);
  }

  subscribe(type: string, handler: EventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }
}
