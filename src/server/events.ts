/** Revision-only server-sent event publication for Shared_State changes. */

import type { SharedStateWithCatalogs } from '../shared/models';
import type { SharedStateRepository } from './repository';

export interface StateChangedEvent {
  type: 'state_changed';
  revision: number;
}

export type StateEventListener = (event: StateChangedEvent) => void;

/**
 * Bridges repository commits to lightweight SSE notifications. Records never
 * cross this boundary; clients use the revision to request `/api/state`.
 */
export class StateEventPublisher {
  private readonly listeners = new Set<StateEventListener>();
  private readonly unsubscribeRepository: () => void;

  constructor(private readonly repository: SharedStateRepository) {
    this.unsubscribeRepository = repository.subscribe(
      (snapshot: SharedStateWithCatalogs) => {
        this.publish({ type: 'state_changed', revision: snapshot.revision });
      }
    );
  }

  subscribe(listener: StateEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: StateChangedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener({ ...event });
      } catch {
        // Event consumers are observational and cannot veto a repository commit.
      }
    }
  }

  close(): void {
    this.unsubscribeRepository();
    this.listeners.clear();
  }
}

export function createStateEventPublisher(
  repository: SharedStateRepository
): StateEventPublisher {
  return new StateEventPublisher(repository);
}

export function serializeStateChangedEvent(event: StateChangedEvent): string {
  // The frame deliberately contains only the event name and revision.
  return `event: state_changed\ndata: ${JSON.stringify(event)}\n\n`;
}

export const RevisionEventPublisher = StateEventPublisher;
