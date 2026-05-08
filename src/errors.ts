export class SmallinvoiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmallinvoiceConfigError';
  }
}

export class SmallinvoiceApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'SmallinvoiceApiError';
  }
}

export class SmallinvoiceAuthError extends SmallinvoiceApiError {
  constructor(status: number, statusText: string, body: unknown, message: string) {
    super(status, statusText, body, message);
    this.name = 'SmallinvoiceAuthError';
  }
}

export class SmallinvoiceTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmallinvoiceTimeoutError';
  }
}

export class SmallinvoiceNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmallinvoiceNetworkError';
  }
}
