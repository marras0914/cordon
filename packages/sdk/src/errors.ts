export class CordonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CordonError";
  }
}

export class PolicyBlocked extends CordonError {
  readonly toolName: string;
  readonly reason: string;
  constructor(toolName: string, reason: string) {
    super(`Policy blocked '${toolName}': ${reason}`);
    this.name = "PolicyBlocked";
    this.toolName = toolName;
    this.reason = reason;
  }
}

export class ApprovalRejected extends CordonError {
  readonly toolName: string;
  constructor(toolName: string) {
    super(`Operator rejected tool call: '${toolName}'`);
    this.name = "ApprovalRejected";
    this.toolName = toolName;
  }
}

export class ApprovalTimeout extends CordonError {
  readonly toolName: string;
  readonly approvalId: string;
  readonly timeout: number;
  constructor(toolName: string, approvalId: string, timeout: number) {
    super(`Approval timeout (${timeout}s) for '${toolName}' (approval_id=${approvalId})`);
    this.name = "ApprovalTimeout";
    this.toolName = toolName;
    this.approvalId = approvalId;
    this.timeout = timeout;
  }
}

export class RateLimited extends CordonError {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super(`Rate limited by Cordon. Retry after ${retryAfter}s.`);
    this.name = "RateLimited";
    this.retryAfter = retryAfter;
  }
}
