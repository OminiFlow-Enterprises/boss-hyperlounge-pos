/** THE BOSS CLUB shows the punched card and table together: `1234/12`. */
export function formatTableNo(code: string, card?: string | null, outlet?: string | null): string {
  const table = String(code ?? "").trim();
  const cardNo = String(card ?? "").trim();
  if (String(outlet ?? "") === "THE BOSS CLUB" && cardNo && table) return `${cardNo}/${table}`;
  return table;
}
