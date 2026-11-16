export class CnError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CnError";
    this.exitCode = exitCode;
  }
}

// A desktop app is running, so its settings were left alone.
export class AppOpenError extends CnError {}

export const EXIT = Object.freeze({ FAILURE: 1, USAGE: 2, NOT_FOUND: 127 });
