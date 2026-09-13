export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(message: string, status = 400, code = "APP_ERROR", details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class InsufficientBalanceError extends AppError {
  constructor(required: number, available: number) {
    super("INSUFFICIENT CARD BALANCE", 409, "INSUFFICIENT_CARD_BALANCE", {
      required,
      available,
      shortfall: required - available,
    });
    this.name = "InsufficientBalanceError";
  }
}

export class PermissionError extends AppError {
  constructor(permission: string) {
    super(`Permission denied: ${permission}`, 403, "PERMISSION_DENIED");
  }
}

export class HardwareError extends AppError {
  constructor(device: string, message: string) {
    super(`${device}: ${message}`, 503, "HARDWARE_FAILURE", { device });
  }
}
