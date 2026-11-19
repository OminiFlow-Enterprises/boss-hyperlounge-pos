import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/hyperlounge.sqlite", { readonly: true });
const c = db.prepare("SELECT paid_balance, bonus_balance FROM member_cards WHERE card_number='1002'").get();
console.log(c);
