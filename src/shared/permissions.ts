import type { StaffRole } from "./types.js";

export const PERMISSIONS = {
  ISSUE_CARD: ["OWNER", "MANAGER", "CASHIER"],
  RECHARGE: ["OWNER", "MANAGER", "CASHIER"],
  CARD_SWAP: ["OWNER", "MANAGER"],
  CARD_BLOCK: ["OWNER", "MANAGER"],
  CARD_UNBLOCK: ["OWNER", "MANAGER"],
  BALANCE_ADJUST: ["OWNER"],
  REFUND: ["OWNER", "MANAGER"],
  PRICE_OVERRIDE: ["OWNER", "MANAGER"],
  LARGE_DISCOUNT: ["OWNER", "MANAGER"],
  CANCEL_INVOICE: ["OWNER", "MANAGER"],
  VOID_KOT: ["OWNER", "MANAGER", "CASHIER"],
  MODIFY_STOCK: ["OWNER", "MANAGER"],
  SERVICE_CHARGE_OVERRIDE: ["OWNER", "MANAGER"],
  DAY_CLOSE: ["OWNER", "MANAGER", "CASHIER"],
  VIEW_REPORTS: ["OWNER", "MANAGER"],
  MANAGE_STAFF: ["OWNER", "MANAGER"],
  SETTINGS: ["OWNER"],
  CREATE_ORDER: ["OWNER", "MANAGER", "CASHIER", "WAITER"],
  SEND_KOT: ["OWNER", "MANAGER", "CASHIER", "WAITER"],
  REQUEST_BILL: ["OWNER", "MANAGER", "CASHIER", "WAITER"],
  SETTLE_BILL: ["OWNER", "MANAGER", "CASHIER"],
  KDS_KITCHEN: ["OWNER", "MANAGER", "KITCHEN"],
  KDS_BAR: ["OWNER", "MANAGER", "BAR"],
} as const;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: StaffRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
}

export function assertPermission(role: StaffRole, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new Error(`Permission denied: ${permission}`);
  }
}
