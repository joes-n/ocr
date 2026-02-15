import type { AppState } from "./types";

type StateListener = (state: AppState) => void;

const VALID_TRANSITIONS: Record<AppState, AppState[]> = {
  Ready: ["Scanning", "RetryNeeded"],
  Scanning: ["Recognized", "RetryNeeded", "Ready"],
  Recognized: ["Scanning", "Ready"],
  RetryNeeded: ["Scanning", "Ready"]
};

export class ScanController {
  private state: AppState;
  private listeners: Set<StateListener>;

  constructor(initialState: AppState = "Ready") {
    this.state = initialState;
    this.listeners = new Set<StateListener>();
  }

  getState(): AppState {
    return this.state;
  }

  setState(nextState: AppState): void {
    const allowedNextStates = VALID_TRANSITIONS[this.state];

    if (nextState === this.state || allowedNextStates.includes(nextState)) {
      this.state = nextState;
      this.notify();
      return;
    }

    throw new Error(`Invalid scan state transition: ${this.state} -> ${nextState}`);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
