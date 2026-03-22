/**
 * Custom error classes for signal processing pipeline.
 */

export class SignalProcessingError extends Error {
  constructor(
    message: string,
    public signalId: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'SignalProcessingError';
  }
}

export class UsageExceededError extends Error {
  constructor(
    public tenantId: string,
    public currentCount: number,
    public limit: number
  ) {
    super(`Usage limit exceeded for tenant ${tenantId}: ${currentCount}/${limit}`);
    this.name = 'UsageExceededError';
  }
}

export class EntityMatchError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message);
    this.name = 'EntityMatchError';
  }
}

export class CredentialError extends Error {
  constructor(message: string, public source: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

export class DataverseError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public requestId?: string
  ) {
    super(message);
    this.name = 'DataverseError';
  }
}
