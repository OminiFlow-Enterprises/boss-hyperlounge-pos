export type UserRoleLabel = "ADMIN" | "OPERATOR" | "ADVANCE" | "CASHIER";

export function isUserRoleLabel(value: unknown): value is UserRoleLabel {
  return value === "ADMIN" || value === "OPERATOR" || value === "ADVANCE" || value === "CASHIER";
}

export function isAdminActor(actor: { role: string; userGroup?: UserRoleLabel } | null | undefined): boolean {
  if (!actor) return false;
  return actor.userGroup ? actor.userGroup === "ADMIN" : actor.role === "OWNER" || actor.role === "MANAGER";
}

export type UserFlags = {
  hideCollection: boolean;
  hideEstimate: boolean;
  allowComplementary: boolean;
  advanceCardUpdate: boolean;
};

export type BillFlags = {
  serviceCharge: boolean;
  discount: boolean;
  itemQty: boolean;
  itemRate: boolean;
  tableTransfer: boolean;
  itemTransfer: boolean;
};

export type OutletRight = {
  outlet: string;
  disc: string;
  minusKot: "Yes" | "No";
};

export type RightNode = {
  id: string;
  label: string;
  children?: RightNode[];
};

export const USER_OUTLETS = ["BAR", "THE BOSS CLUB", "RESTAURANT", "NC"] as const;
export const ADVANCE_OUTLETS = USER_OUTLETS.filter((outlet) => outlet !== "NC");

export function isAdvanceOutlet(outlet: unknown): outlet is (typeof ADVANCE_OUTLETS)[number] {
  return ADVANCE_OUTLETS.some((allowed) => allowed === outlet);
}

const OUTLET_REPORTS: RightNode[] = [
  { id: "report.kot", label: "KOT Report" },
  { id: "report.bill", label: "Bill Report" },
  { id: "report.settlement", label: "Settlement Report" },
];

const REPORT_RIGHTS: RightNode[] = [
  ...OUTLET_REPORTS,
  { id: "report.gst", label: "GST Report" },
  { id: "report.pos", label: "Point Of Sales" },
  { id: "report.item", label: "Item Wise Sales" },
  { id: "report.itemDetail", label: "Item Wise Sales Detail" },
  { id: "report.stock", label: "Item Combine Stock Report" },
  { id: "report.outlet", label: "Outlet Wise Stock Report" },
  { id: "report.time", label: "Time Sale Report" },
  { id: "report.tax", label: "Tax Wise Report" },
  { id: "report.card", label: "Card Settlement Report" },
  { id: "report.booking", label: "Booking Report" },
  { id: "report.itemTransfer", label: "Item Transfer Report" },
  { id: "report.tableTransfer", label: "Table Transfer Report" },
  { id: "report.kotCancellation", label: "KOT Cancellation Report" },
];

export function reportsForGroup(group: UserRoleLabel): RightNode[] {
  return group === "OPERATOR" || group === "ADVANCE" ? OUTLET_REPORTS : REPORT_RIGHTS;
}

export const RIGHTS_TREE: RightNode[] = [
  {
    id: "master",
    label: "Master",
    children: [
      { id: "master.user", label: "User" },
      { id: "master.item", label: "Item" },
    ],
  },
  {
    id: "fnb",
    label: "F n B",
    children: [
      { id: "fnb.bar", label: "BAR" },
      { id: "fnb.nc", label: "NC" },
      { id: "fnb.restaurant", label: "RESTAURANT" },
      { id: "fnb.club", label: "THE BOSS CLUB" },
      { id: "fnb.advance", label: "Advance Booking" },
    ],
  },
  {
    id: "report",
    label: "Report",
    children: REPORT_RIGHTS,
  },
  { id: "setting", label: "Setting" },
  { id: "logout", label: "Logout" },
];

export function blankOutlets(): OutletRight[] {
  return USER_OUTLETS.map((outlet) => ({ outlet, disc: "", minusKot: "Yes" }));
}

export function allRightIds(): string[] {
  const ids: string[] = [];
  const walk = (node: RightNode) => {
    ids.push(node.id);
    node.children?.forEach(walk);
  };
  RIGHTS_TREE.forEach(walk);
  return ids;
}

export function rightsPreset(role: UserRoleLabel): Record<string, boolean> {
  const ids = allRightIds();
  if (role === "ADMIN") return Object.fromEntries(ids.map((id) => [id, true]));
  if (role === "CASHIER") return Object.fromEntries(ids.map((id) => [id, id !== "master" && !id.startsWith("master.")]));
  if (role === "OPERATOR") return barOrderRights();
  const on = new Set(["fnb", ...ADVANCE_OUTLETS.map(outletRight), ...OUTLET_REPORTS.map((report) => report.id), "report", "logout"]);
  return Object.fromEntries(ids.map((id) => [id, on.has(id)]));
}

export function barOrderRights(): Record<string, boolean> {
  return Object.fromEntries(allRightIds().map((id) => [id, ["fnb", "fnb.bar", "logout"].includes(id)]));
}

export function isBarOrderOnly(rights: Record<string, boolean> | null | undefined): boolean {
  return rights?.["fnb.bar"] === true && USER_OUTLETS.every(
    (outlet) => outlet === "BAR" || rights[outletRight(outlet)] !== true,
  );
}

export function flagsPreset(role: UserRoleLabel): UserFlags {
  return {
    hideCollection: false,
    hideEstimate: role === "ADVANCE",
    allowComplementary: role === "ADMIN" || role === "CASHIER",
    advanceCardUpdate: role === "ADMIN" || role === "CASHIER",
  };
}

export function billPreset(role: UserRoleLabel): BillFlags {
  const admin = role === "ADMIN";
  return {
    serviceCharge: role !== "OPERATOR",
    discount: admin || role === "CASHIER",
    itemQty: admin || role === "CASHIER",
    itemRate: admin,
    tableTransfer: role !== "OPERATOR",
    itemTransfer: role !== "OPERATOR",
  };
}

export function findRight(id: string, nodes: RightNode[] = RIGHTS_TREE): RightNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = node.children ? findRight(id, node.children) : null;
    if (child) return child;
  }
  return null;
}

export function applyRight(rights: Record<string, boolean>, id: string, on: boolean): Record<string, boolean> {
  const next = { ...rights };
  const node = findRight(id);
  const walk = (n: RightNode) => {
    next[n.id] = on;
    n.children?.forEach(walk);
  };
  if (node) walk(node);
  else next[id] = on;
  const fix = (n: RightNode): boolean => {
    if (!n.children?.length) return Boolean(next[n.id]);
    const any = n.children.some(fix);
    next[n.id] = any;
    return any;
  };
  RIGHTS_TREE.forEach(fix);
  return next;
}

/** Null rights means this user has not been saved from User Master yet — keep full access. */
export function rightOn(rights: Record<string, boolean> | null | undefined, id: string): boolean {
  if (!rights) return true;
  if (!id) return true;
  if (rights[id] === true) return true;
  if (rights[id] === false) return false;
  const parent = id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "";
  if (parent && rights[parent] === true) return true;
  return false;
}

export function outletRight(outlet: string): string {
  if (outlet === "THE BOSS CLUB") return "fnb.club";
  if (outlet === "RESTAURANT") return "fnb.restaurant";
  if (outlet === "NC") return "fnb.nc";
  return "fnb.bar";
}

export function canViewNcEstimate(actor: {
  rights?: Record<string, boolean> | null;
  hideEstimate?: boolean | null;
} | null | undefined): boolean {
  return !!actor && !actor.hideEstimate && rightOn(actor.rights, outletRight("NC"));
}

export function viewRight(view: string, outlet?: string): string | null {
  if (view === "user-master") return "master.user";
  if (view === "gst-report") return "report.gst";
  if (view === "point-of-sales") return "report.pos";
  if (view === "item-wise-sale") return "report.item";
  if (view === "item-wise-group") return "report.item";
  if (view === "item-wise-detail") return "report.itemDetail";
  if (view === "item-combine-stock") return "report.stock";
  if (view === "outlet-stock") return "report.outlet";
  if (view === "time-sale") return "report.time";
  if (view === "tax-wise") return "report.tax";
  if (view === "card-settlement-report") return "report.card";
  if (view === "kot-cancellation-report") return "report.kotCancellation";
  if (view === "item-transfer-report") return "report.itemTransfer";
  if (view === "table-transfer-report") return "report.tableTransfer";
  if (view === "kot-report") return "report.kot";
  if (view === "bill-report" || view === "history") return "report.bill";
  if (view === "settlement-report") return "report.settlement";
  if (view === "booking-report") return "report.booking";
  if (view === "advance-booking" || view === "card-block") return "fnb.advance";
  if (view === "billing") return outlet ? outletRight(outlet) : "fnb";
  return null;
}

export function roleLabel(role: string, userRole?: string | null): UserRoleLabel {
  if (isUserRoleLabel(userRole)) return userRole;
  if (role === "OWNER" || role === "MANAGER") return "ADMIN";
  return "OPERATOR";
}

export function mergeOutlets(saved: OutletRight[] | null | undefined): OutletRight[] {
  const byName = new Map((saved ?? []).map((row) => [row.outlet, row]));
  return USER_OUTLETS.map((outlet) => {
    const row = byName.get(outlet);
    return {
      outlet,
      disc: row?.disc ?? "",
      minusKot: row?.minusKot === "No" ? "No" : "Yes",
    };
  });
}
