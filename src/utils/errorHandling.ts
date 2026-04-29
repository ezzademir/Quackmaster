/**
 * Error Handling & Retry Logic
 * Graceful recovery from transient failures
 */

export interface RetryConfig {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterFactor?: number;
}

export class BusinessLogicError extends Error {
  constructor(
    message: string,
    public code: string,
    public isRetryable: boolean = false,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'BusinessLogicError';
  }
}

/**
 * Determine if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof BusinessLogicError) {
    return error.isRetryable;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Network errors, timeouts, rate limits are retryable
    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('temporarily unavailable') ||
      message.includes('rate limit')
    );
  }

  return false;
}

/**
 * Calculate exponential backoff delay with jitter
 */
export function calculateBackoffDelay(
  attempt: number,
  config: RetryConfig = {}
): number {
  const initialDelay = config.initialDelayMs ?? 100;
  const maxDelay = config.maxDelayMs ?? 5000;
  const multiplier = config.backoffMultiplier ?? 2;
  const jitterFactor = config.jitterFactor ?? 0.1;

  // Exponential backoff: base_delay * multiplier^attempt
  const exponentialDelay = initialDelay * Math.pow(multiplier, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelay);

  // Add jitter: +/- (jitterFactor * delay)
  const jitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1);

  return Math.max(100, cappedDelay + jitter);
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig = {}
): Promise<T> {
  const maxAttempts = config.maxAttempts ?? 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxAttempts - 1;
      const retryable = isRetryableError(error);

      if (isLastAttempt || !retryable) {
        throw error;
      }

      const delayMs = calculateBackoffDelay(attempt, config);
      await sleep(delayMs);
    }
  }

  throw new Error('Retry failed after max attempts');
}

/**
 * Retry multiple operations concurrently with individual retries
 */
export async function retryMultipleOperations<T>(
  operations: Array<{ id: string; fn: () => Promise<T> }>,
  config: RetryConfig = {}
): Promise<Array<{ id: string; success: boolean; result?: T; error?: Error }>> {
  return Promise.all(
    operations.map(async (op) => {
      try {
        const result = await retryWithBackoff(op.fn, config);
        return { id: op.id, success: true, result };
      } catch (error) {
        return {
          id: op.id,
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    })
  );
}

/**
 * Circuit breaker pattern for handling cascading failures
 */
export class CircuitBreaker {
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: number;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private failureThreshold: number = 5,
    private successThreshold: number = 2,
    private resetTimeoutMs: number = 60000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const timeSinceFailure = Date.now() - (this.lastFailureTime || 0);
      if (timeSinceFailure > this.resetTimeoutMs) {
        this.state = 'half-open';
        this.successCount = 0;
      } else {
        throw new Error('Circuit breaker is OPEN - service temporarily unavailable');
      }
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private recordSuccess(): void {
    this.failureCount = 0;

    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'closed';
        this.successCount = 0;
      }
    }
  }

  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  getStatus(): { state: 'closed' | 'open' | 'half-open'; failureCount: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
    };
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = undefined;
  }
}

/**
 * Concurrent operation manager with conflict detection
 */
export interface ConflictResolutionStrategy {
  strategy: 'first-wins' | 'last-wins' | 'merge';
  onConflict?: (results: unknown[]) => unknown;
}

export async function manageConcurrentOperations<T>(
  operations: Array<{ id: string; fn: () => Promise<T> }>
): Promise<{ results: Map<string, T>; conflicts: string[] }> {
  const results = new Map<string, T>();
  const conflicts: string[] = [];

  const responses = await Promise.allSettled(operations.map((op) => op.fn()));

  operations.forEach((op, index) => {
    const response = responses[index];
    if (response.status === 'fulfilled') {
      results.set(op.id, response.value);
    } else {
      conflicts.push(`${op.id}: ${response.reason}`);
    }
  });

  return { results, conflicts };
}

/**
 * Error context builder for better debugging
 */
export interface ErrorContext {
  operation: string;
  entityType: string;
  entityId?: string;
  timestamp: string;
  userContext?: {
    userId: string;
    userEmail: string;
  };
  metadata?: Record<string, unknown>;
}

export function buildErrorContext(base: Omit<ErrorContext, 'timestamp'>): ErrorContext {
  return {
    ...base,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format error for logging with full context
 */
export function formatErrorForLogging(error: Error, context: ErrorContext): string {
  return `
[${context.timestamp}] ${context.operation} failed
Entity: ${context.entityType}${context.entityId ? ` #${context.entityId}` : ''}
User: ${context.userContext?.userEmail || 'unknown'}
Error: ${error.message}
${context.metadata ? `Metadata: ${JSON.stringify(context.metadata)}` : ''}
  `.trim();
}
