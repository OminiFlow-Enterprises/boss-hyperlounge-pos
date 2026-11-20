export type UserRoleLabel = "ADMIN" | "OPERATOR";

export type UserFlags = {
  hideCollection: boolean;
  hideEstimate: boolean;
  allowComplementary: boolean;
  advanceCardUpdate: boolean;
  showCheckinRooms: boolean;
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

export const USER_OUTLETS = ["CAFE", "BAR", "THE BOSS CLUB", "RESTAURANT", "NC"] as const;

export const RIGHTS_TREE: RightNode[] = [
  {
    id: "master",
    label: "Master",
    children: [
      { id: "master.user", label: "User" },
      { id: "master.item", label: "Item" },
    ],
  },
  { id: "front", label: "Front Office" },
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
  { id: "special", label: "Special Services" },
  { id: "account", label: "Account" },
  { id: "store", label: "Store" },
  { id: "house", label: "House Keeping" },
  { id: "cms", label: "CMS" },
  {
    id: "report",
    label: "Report",
    children: [
      { id: "report.gst", label: "GST Report" },
      { id: "report.pos", label: "Point Of Sales" },
      { id: "report.item", label: "Item Wise Sales" },
      { id: "report.itemDetail", label: "Item Wise Sales Detail" },
      { id: "report.stock", label: "Item Combine Stock Report" },
      { id: "report.outlet", label: "Outlet Wise Stock Report" },
      { id: "report.time", label: "Time Sale Report" },
      { id: "report.tax", label: "Tax Wise Report" },
      { id: "report.settlement", label: "Settlement Report" },
      { id: "report.card", label: "Card Settlement Report" },
    ],
  },
  { id: "setting", label: "Setting" },
  { id: "spa", label: "SpaSaloon" },
  { id: "logout", label: "Logout" },
  { id: "notification", label: "Notification" },
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
  const on = new Set([
    "fnb", "fnb.bar", "fnb.nc", "fnb.restaurant", "fnb.club", "fnb.advance",
    "report", "report.gst", "report.pos", "report.item", "report.itemDetail",
    "report.stock", "report.outlet", "report.time", "report.tax", "report.settlement", "report.card",
    "logout",
  ]);
  return Object.fromEntries(ids.map((id) => [id, on.has(id)]));
}

export function flagsPreset(role: UserRoleLabel): UserFlags {
  return {
    hideCollection: false,
    hideEstimate: false,
    allowComplementary: true,
    advanceCardUpdate: role === "ADMIN",
    showCheckinRooms: false,
  };
}

export function billPreset(role: UserRoleLabel): BillFlags {
  const admin = role === "ADMIN";
  return {
    serviceCharge: admin,
    discount: true,
    itemQty: true,
    itemRate: admin,
    tableTransfer: true,
    itemTransfer: true,
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
  if (outlet === "CAFE") return "fnb.cafe";
  return "fnb.bar";
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
  if (view === "booking-report" || view === "advance-booking" || view === "card-block") return "fnb.advance";
  if (view === "billing" || view === "kot-report" || view === "bill-report" || view === "history" || view === "settlement-report") {
    if (outlet) return outletRight(outlet);
    if (view === "settlement-report") return "report.settlement";
    return "fnb";
  }
  return null;
}

export function roleLabel(role: string, userRole?: string | null): UserRoleLabel {
  if (userRole === "ADMIN" || userRole === "OPERATOR") return userRole;
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
