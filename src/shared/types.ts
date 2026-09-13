export type CardStatus = "ACTIVE" | "BLOCKED" | "LOST" | "EXPIRED" | "INACTIVE" | "REPLACED";

export type CardTypeCode = "REGULAR" | "MEMBER" | "VIP" | "CORPORATE";

export type LedgerType =
  | "RECHARGE"
  | "PURCHASE"
  | "REFUND"
  | "TRANSFER"
  | "CARD_SWAP"
  | "ADJUSTMENT"
  | "BONUS"
  | "EXPIRY"
  | "REVERSAL";

export type LedgerDirection = "CREDIT" | "DEBIT";

export type PaymentMode = "CASH" | "UPI" | "CARD" | "MEMBER_CARD" | "OTHER";

export type TableStatus =
  | "AVAILABLE"
  | "OCCUPIED"
  | "RESERVED"
  | "BILL_REQUESTED"
  | "PAYMENT_PENDING";

export type Station = "KITCHEN" | "BAR";

export type KotStatus = "NEW" | "SENT" | "ACCEPTED" | "PREPARING" | "READY" | "SERVED" | "VOID";

export type KotType = "NEW" | "ADDITION" | "VOID" | "CANCEL" | "MODIFICATION";

export type OrderStatus = "OPEN" | "BILL_REQUESTED" | "SETTLING" | "PAID" | "CANCELLED";

export type InvoiceStatus = "DRAFT" | "UNPAID" | "PARTIAL" | "PAID" | "CANCELLED" | "REFUNDED";

export type StaffRole = "OWNER" | "MANAGER" | "CASHIER" | "WAITER" | "KITCHEN" | "BAR";

export type ServiceChargeMode = "INCLUSIVE" | "EXCLUSIVE";

export type SplitType = "ITEM" | "QUANTITY" | "AMOUNT" | "EQUAL";

export type BlockReason = "Lost" | "Damaged" | "Suspicious activity" | "Customer request" | "Replaced";

export type SyncStatus = "PENDING" | "SYNCING" | "SYNCED" | "FAILED";

export interface Actor {
  staffId: string;
  staffName: string;
  role: StaffRole;
  terminalId: string;
  terminalName: string;
}

export interface CardBalances {
  paid: number;
  bonus: number;
  usable: number;
}

export interface InsufficientBalance {
  required: number;
  available: number;
  shortfall: number;
}

export interface PaymentLine {
  method: PaymentMode;
  amount: number;
  memberCardId?: string;
  reference?: string;
}

export interface NavView =
  | "home"
  | "pos"
  | "tables"
  | "orders"
  | "kot"
  | "kitchen"
  | "bar"
  | "cards"
  | "recharge"
  | "balance"
  | "swap"
  | "ledger"
  | "customers"
  | "products"
  | "inventory"
  | "purchase"
  | "expenses"
  | "reports"
  | "staff"
  | "settings"
  | "checkin"
  | "history";
