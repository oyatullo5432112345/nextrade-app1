import fs from "fs";
import path from "path";
import { pool } from "./pool";

export async function ensureSchema(): Promise<void> {
  const candidates = [
    path.join(__dirname, "schema.sql"),
    path.join(__dirname, "..", "..", "src", "db", "schema.sql"),
  ];

  const schemaPath = candidates.find((p) => fs.existsSync(p));

  if (!schemaPath) {
    console.error("❌ schema.sql topilmadi:", candidates);
    return;
  }

  const schema = fs.readFileSync(schemaPath, "utf-8");

  try {
    await pool.query(schema);
    console.log("✅ Baza sxemasi tekshirildi/yangilandi");
  } catch (err) {
    console.error("❌ Baza sxemasini o'rnatishda xato:", err);
  }
}
